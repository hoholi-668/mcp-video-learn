// 动图 WebP 的 sharp 解码路径（可选依赖）。
//
// 为什么需要：ffmpeg 4.x 的 webp 解码器只认静态图，动图 WebP 会解出 0×0。
// DSH 自己用 sharp（libvips）解这类图，这里保持一致：装了 sharp 就能看动图，
// 没装就返回明确错误，让调用方知道该装什么。
//
// 可选依赖的定位：不装 sharp 时本模块所有函数都返回 { ok:false, missing:true }，
// 调用方据此给出提示，不影响其它格式。

let sharpPromise = null;

/**
 * 懒加载 sharp：
 *   1) 常规 import('sharp')
 *   2) SHARP_MODULE 指定的路径（既能是包名，也能是宿主里已装 sharp 的目录）
 *
 * 为什么用 createRequire：sharp 是 CJS 包，而且 SHARP_MODULE 常见用法是指向一个
 * 「已装好 sharp 的 node_modules 目录」。ESM 的 import() 不接受目录（会报
 * ERR_UNSUPPORTED_DIR_IMPORT），require 才能按 package.json 正常解析。
 */
export function loadSharp() {
  if (sharpPromise) return sharpPromise;
  sharpPromise = (async () => {
    try {
      const mod = await import('sharp');
      const sharp = mod?.default ?? mod;
      if (typeof sharp === 'function') return sharp;
    } catch { /* 继续 */ }
    const override = process.env.SHARP_MODULE;
    if (override) {
      try {
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        const mod = require(override);
        const sharp = mod?.default ?? mod;
        if (typeof sharp === 'function') return sharp;
      } catch (error) {
        console.error(`[webp-sharp] SHARP_MODULE 加载失败：${error?.message ?? error}`);
      }
    }
    return null;
  })();
  return sharpPromise;
}

/** 用 sharp 看一个 webp 有几页（>1 = 动图）。没有 sharp 时返回 0。 */
export async function webpPages(file) {
  const sharp = await loadSharp();
  if (!sharp) return 0;
  try {
    const meta = await sharp(file, { animated: true }).metadata();
    return Number(meta.pages) || 1;
  } catch {
    return 0;
  }
}

/** 判断一批帧是不是“全空白”（坏文件的典型特征：每帧都是纯色/透明）。 */
async function framesAreBlank(sharp, tiles) {
  for (const t of tiles) {
    try {
      const stats = await sharp(t.buf).stats();
      const maxStdev = Math.max(...stats.channels.map((c) => Number(c.stdev) || 0));
      if (maxStdev >= 1) return false; // 有一帧有内容
    } catch {
      return false; // 统计失败就不下“空白”结论
    }
  }
  return true;
}

/**
 * 用 sharp 解动图 WebP，抽 N 帧拼成网格。
 *
 * sharp 的 `animated: true` 让 libvips 把每一页都读进来；再按页取单帧、
 * 缩放到 tileWidth，最后用 composite 拼成 cols×rows。
 *
 * @returns {{ok:boolean, outJpg?:string, frames?:number, error?:string, missing?:boolean}}
 */
export async function webpGridWithSharp({ file, want, cols, rows, tileWidth = 240, outJpg, padding = 4 }) {
  const sharp = await loadSharp();
  if (!sharp) {
    return {
      ok: false,
      missing: true,
      error: '动图 WebP 需要 sharp（可选依赖）或 ffmpeg 6.x 才能解码；'
        + '静态 WebP 不受影响。安装方式：npm i sharp，或设 SHARP_MODULE 指向已安装的 sharp。'
    };
  }
  try {
    // 先取元信息：页数、尺寸
    const meta = await sharp(file, { animated: true }).metadata();
    const total = Number(meta.pages || meta.pageHeight && 1 || 1) || 1;
    const width = Number(meta.width) || 0;
    const height = Number(meta.pageHeight || meta.height) || 0;
    if (!width || !height) return { ok: false, error: 'sharp 也读不出这个 WebP 的尺寸（文件可能损坏）' };

    // 按页抽帧：均匀挑 want 个页号
    const picks = [];
    for (let i = 0; i < want; i += 1) {
      const page = total <= want ? i : Math.round((i * (total - 1)) / Math.max(1, want - 1));
      picks.push(Math.min(total - 1, page));
    }

    const tiles = [];
    for (const page of picks) {
      const buf = await sharp(file, { page, pages: 1 })
        .resize({ width: tileWidth, withoutEnlargement: false })
        .jpeg({ quality: 80 })
        .toBuffer();
      const m = await sharp(buf).metadata();
      tiles.push({ buf, w: Number(m.width) || tileWidth, h: Number(m.height) || 1 });
    }

    const cellW = Math.max(...tiles.map((t) => t.w));
    const cellH = Math.max(...tiles.map((t) => t.h));
    const canvasW = cols * cellW + (cols - 1) * padding;
    const canvasH = rows * cellH + (rows - 1) * padding;

    const composites = tiles.map((t, i) => ({
      input: t.buf,
      left: (i % cols) * (cellW + padding),
      top: Math.floor(i / cols) * (cellH + padding)
    }));

    await sharp({
      create: { width: canvasW, height: canvasH, channels: 3, background: { r: 255, g: 255, b: 255 } }
    })
      .composite(composites)
      .jpeg({ quality: 82 })
      .toFile(outJpg);

    // 反“假成功”：坏掉的 WebP 也能被 libvips 解成若干空白页（实测一张 320 字节的
    // 残缺文件会报 pages=2 且不报错）。所以先看这些帧是不是全空白。
    if (await framesAreBlank(sharp, tiles)) {
      try { await import('node:fs').then(({ unlinkSync }) => unlinkSync(outJpg)); } catch {}
      return { ok: false, error: `解出来的 ${tiles.length} 帧全是空白：原文件可能已损坏，或不是真正的动图 WebP` };
    }

    return { ok: true, outJpg, frames: tiles.length, pages: total, width, height };
  } catch (error) {
    return { ok: false, error: `sharp 解码失败：${error?.message ?? error}` };
  }
}
