// 抽帧管线：与 MCP 入口解耦，可单独跑真实视频做自测。
//
// 依赖外部可执行文件（ffmpeg / ffprobe / yt-dlp），所以这里只管“怎么调”，
// 不管 MCP 的 tool 注册与参数校验。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pickVideoFile } from './lib.js';
import { gridForFrames, tileFilter, describeProbe } from './media.js';
import { pickTimestamps } from './filmstrip.js';
import { webpGridWithSharp, webpPages } from './webp-sharp.js';
import { makeBiliApi } from './bili-api.js';

/** 拼 B 站 API 的 Cookie 头：登录态 + buvid3（去重、去空）。 */
export function buildBiliCookieHeader(cookieHeader, buvid3) {
  const parts = [];
  const raw = String(cookieHeader || '').trim().replace(/;\s*$/, '');
  if (raw) parts.push(raw);
  if (buvid3 && !/buvid3=/.test(raw)) parts.push(`buvid3=${buvid3}`);
  return parts.join('; ');
}

/** 组装 yt-dlp 的 B 站下载参数（纯函数，便于测试是否真的带上了 cookies）。 */
export function buildBiliDlpArgs({ cookieFile, maxDownload, outTemplate, url }) {
  const args = ['--no-warnings', '--no-playlist'];
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push('-f', 'bv*[height<=480]+ba/b[height<=480]/worst', '--max-filesize', String(maxDownload), '-o', outTemplate, url);
  return args;
}

export function makePipeline({
  ffmpeg = process.env.VIDEO_FFMPEG || 'ffmpeg',
  ytdlp = process.env.VIDEO_YTDLP || 'yt-dlp',
  maxDownloadMb = Number(process.env.VIDEO_MAX_MB) || 60,
  stepTimeoutMs = 120_000,
  allowRoots = [process.cwd(), os.tmpdir()],
  cookiesPath = ''
} = {}) {
  const maxDownload = maxDownloadMb * 1024 * 1024;
  // B 站登录态：
  //   BILI_COOKIES = cookies.txt 路径（给 yt-dlp 用）
  //   BILI_COOKIE  = 原始 cookie 串（给官方 API 用）
  const biliCookiesFile = process.env.BILI_COOKIES || cookiesPath || '';
  const biliCookieHeader = String(process.env.BILI_COOKIE || '');
  // 官方 API 通道：机房 IP 也能用（不抓网页），优先于 yt-dlp
  const bili = makeBiliApi({ cookiesFile: biliCookiesFile, cookieHeader: biliCookieHeader, maxBytes: maxDownload });
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, 'ffprobe'));

  // ffmpeg 5.1+ 用 -fps_mode，4.x 只认 -vsync（实测 Ubuntu 22.04 自带 4.4 会报
  // "Unrecognized option 'fps_mode'"）。这里探测一次，避免每帧都试错。
  let vsyncFlag; // null=未知
  async function vsyncArgs() {
    if (vsyncFlag) return [vsyncFlag];
    const v = await run(ffmpeg, ['-version'], 10_000);
    const m = /ffmpeg version (\d+)\.(\d+)/.exec(v.stdout || '');
    const major = m ? Number(m[1]) : 0;
    const minor = m ? Number(m[2]) : 0;
    vsyncFlag = (major > 5 || (major === 5 && minor >= 1)) ? '-fps_mode' : '-vsync';
    return [vsyncFlag];
  }

  function run(cmd, args, timeoutMs = stepTimeoutMs) {
    return new Promise((resolve) => {
      let child;
      const chunks = [];
      const errChunks = [];
      try {
        child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, stdout: '', stderr: String(error?.message ?? error) });
        return;
      }
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.stdout.on('data', (d) => chunks.push(d));
      child.stderr.on('data', (d) => errChunks.push(d));
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout: '', stderr: String(error?.message ?? error) });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errChunks).toString('utf8'), code });
      });
    });
  }

  async function probeMedia(file) {
    const res = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
    if (!res.ok) return null;
    try { return JSON.parse(res.stdout); } catch { return null; }
  }

  /**
   * 场景变化候选点。
   *
   * 不用 ffmpeg 的 `select=gt(scene,...)`：它只比亮度，红→绿这种「亮度几乎相同、
   * 色度差异巨大」的切换会整段漏掉（实测短横屏 3 段颜色只抓到 1 个切点）。
   *
   * 改成逐帧画面差分：tblend 求相邻帧差 → signalstats 出 Y/U/V 均值 → 取三者最大。
   * 这样亮度变化和纯色相变化都能抓到（实测红→绿 V=159、绿→蓝 U=149）。
   */
  async function sceneCandidates(file, { minScore = 20, timeoutMs = 180_000 } = {}) {
    const res = await run(ffmpeg, [
      '-v', 'info', '-i', file,
      // 先降到 5fps + 160 宽再算差分：切点检测不需要原始帧率/分辨率，
      // 5 分钟 640×360 的素材从 ~12 秒降到 ~2 秒（实测）。
      '-vf', 'fps=5,scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:file=-',
      '-an', '-f', 'null', '-'
    ], timeoutMs);
    const out = [];
    const blocks = String(res.stdout || '').split('frame:').slice(1);
    for (const b of blocks) {
      const t = /pts_time:([0-9.]+)/.exec(b);
      if (!t) continue;
      const y = Number((/YAVG=([0-9.]+)/.exec(b) || [])[1] || 0);
      const u = Number((/UAVG=([0-9.]+)/.exec(b) || [])[1] || 0);
      const v = Number((/VAVG=([0-9.]+)/.exec(b) || [])[1] || 0);
      // 先 tblend 求差再 signalstats：Y/U/V 的均值本身就是变化幅度（0=没变化），直接取最大。
      // 不要再拿 128 去减——差分平面上没有「中性值」，减了会把静止画面算成巨大变化。
      const score = Math.max(y, u, v);
      if (score >= minScore) out.push({ t: Number(t[1]), score });
    }
    // 0.2 秒内的相邻峰合并成一个（同一刀切换会连着两帧都高）
    const merged = [];
    for (const c of out.sort((a, b) => a.t - b.t)) {
      const last = merged[merged.length - 1];
      if (last && c.t - last.t < 0.2) {
        if (c.score > last.score) Object.assign(last, c);
        continue;
      }
      merged.push({ ...c });
    }
    return merged;
  }

  /**
   * 把时间点补齐到 want 个。
   *
   * 为什么必须补：ffmpeg 的 tile 滤镜要凑满 cols×rows 张才输出一帧；
   * 场景检测只找到 2 个点时只喂 2 帧，会一张图都不出（实测静默失败）。
   * 补法是拿「均匀时间点」填空位，保证每次都能凑满网格。
   */
  function topUpTimestamps(times, want, duration) {
    const uniq = [...new Set((times || []).map((t) => Number(Number(t).toFixed(2))))]
      .filter((t) => Number.isFinite(t) && t >= 0)
      .sort((a, b) => a - b);
    if (uniq.length >= want) return uniq.slice(0, want);
    const merged = [...uniq];
    const span = duration > 0.05 ? duration : 0;
    for (let i = 0; i < want && merged.length < want; i += 1) {
      const t = Number((span > 0 ? span * ((i + 0.5) / want) : i).toFixed(2));
      if (!merged.some((x) => Math.abs(x - t) < 0.05)) merged.push(t);
    }
    merged.sort((a, b) => a - b);
    return merged.slice(0, want);
  }

  /**
   * 生成帧网格。
   * 主路径：场景变化 → FIFO 队列（overview/recent 两种取用），不足 want 时用均匀点补齐
   * 退路：场景检测拿不到点时按 fps 均匀采样
   */
  async function buildVideoGrid({ file, want, tileWidth = 240, strategy = 'overview', dir }) {
    const grid = gridForFrames(want);
    const outJpg = path.join(dir, 'grid.jpg');
    const meta = describeProbe(await probeMedia(file));
    const duration = meta.durationSec > 0.05 ? meta.durationSec : 0;

    // 动图 WebP：ffmpeg 4.x 只能读出第一帧（甚至 0×0），所以优先问 sharp 有几页；
    // 页数 >1 就直接走 sharp 逐帧解码，否则按静态图交给 ffmpeg。
    if (/\.webp$/i.test(String(file))) {
      const pages = await webpPages(file);
      if (pages > 1) {
        const viaSharp = await webpGridWithSharp({
          file, want, cols: grid.cols, rows: grid.rows, tileWidth, outJpg
        });
        if (viaSharp.ok) {
          return {
            ok: true, outJpg, mode: 'webp-sharp',
            timestamps: [], candidates: viaSharp.pages || 0,
            width: viaSharp.width, height: viaSharp.height, pages: viaSharp.pages, frames: viaSharp.frames,
            note: `动图 WebP 经 sharp 解码（共 ${viaSharp.pages} 页，取 ${viaSharp.frames} 帧）`
          };
        }
        return { ok: false, error: viaSharp.error, missingSharp: !!viaSharp.missing };
      }
    }

    // ffmpeg 4.x 的 webp 解码器只认静态 webp：动图 webp 会解出 0×0。
    // 这时优先用 sharp（libvips，DSH 自己也是用它）逐帧解码；没有 sharp 再给明确提示。
    if (meta.width <= 0 || meta.height <= 0) {
      if (/\.webp$/i.test(String(file))) {
        const viaSharp = await webpGridWithSharp({
          file, want, cols: grid.cols, rows: grid.rows, tileWidth, outJpg
        });
        if (viaSharp.ok) {
          return {
            ok: true, outJpg, mode: 'webp-sharp',
            timestamps: [], candidates: viaSharp.pages || 0,
            width: viaSharp.width, height: viaSharp.height, pages: viaSharp.pages, frames: viaSharp.frames,
            note: `动图 WebP 经 sharp 解码（共 ${viaSharp.pages || '?'} 页，取 ${viaSharp.frames} 帧）`
          };
        }
        return { ok: false, error: viaSharp.error, missingSharp: !!viaSharp.missing };
      }
      return {
        ok: false,
        error: 'ffmpeg 解不开这个文件（探测不到画面尺寸，可能已损坏或不是媒体）'
      };
    }

    // 只要 1 帧 → 均匀采样即可，场景检测没有意义
    if (want < 2) return uniformGrid({ file, want, tileWidth, grid, outJpg });

    // 阈值逐级放宽：0.25 抓硬切，画面差异小的素材（同色系、渐变）会漏。
    // 每一级都比上一级多抓一些点，抓到 ≥2 个就停。
    let candidates = [];
    for (const threshold of [20, 10, 5]) {
      candidates = await sceneCandidates(file, { minScore: threshold });
      if (candidates.length >= 2) break;
    }
    // 变化点少于 2 个 = 这段素材确实没有镜头切换（纯色、单图、极短），
    // 这时补帧也只是假装在“按场景取”，不如老实走均匀采样。
    if (candidates.length < 2) {
      const plain = await uniformGrid({ file, want, tileWidth, grid, outJpg });
      return { ...plain, candidates: candidates.length };
    }
    const picked = pickTimestamps(candidates, want, strategy);
    const times = topUpTimestamps(picked, want, duration);

    if (times.length >= 2) {
      const terms = times
        .map((t) => `between(t,${Math.max(0, t - 0.02).toFixed(3)},${(t + 0.02).toFixed(3)})`)
        .join('+');
      const vf = `select='${terms}',${tileFilter(grid, { tileWidth })}`;
      const [flag] = await vsyncArgs();
      const ff = await run(ffmpeg, ['-v', 'error', '-y', '-i', file, '-vf', vf, flag, 'vfr', '-frames:v', '1', '-q:v', '4', outJpg]);
      if (ff.ok && fs.existsSync(outJpg)) {
        return { ok: true, outJpg, mode: 'scene', timestamps: times, candidates: candidates.length };
      }
      // 场景路径失败时把 stderr 带回去，方便排查，而不是静默退回均匀采样
      const sceneError = ff.stderr?.slice(0, 300) || 'ffmpeg 无输出';
      const fallback = await uniformGrid({ file, want, tileWidth, grid, outJpg });
      return fallback.ok
        ? { ...fallback, sceneError, candidates: candidates.length }
        : { ok: false, error: sceneError };
    }

    return uniformGrid({ file, want, tileWidth, grid, outJpg });
  }

  /** 退路：按时长均匀采样（场景检测拿不到点时用）。 */
  /** 在给定时间点抽帧拼一张网格（分段模式复用）。 */
  async function renderAtTimes(file, times, grid, tileWidth, outJpg) {
    const terms = times
      .map((t) => `between(t,${Math.max(0, t - 0.02).toFixed(3)},${(t + 0.02).toFixed(3)})`)
      .join('+');
    const vf = `select='${terms}',${tileFilter(grid, { tileWidth })}`;
    const [flag] = await vsyncArgs();
    const ff = await run(ffmpeg, ['-v', 'error', '-y', '-i', file, '-vf', vf, flag, 'vfr', '-frames:v', '1', '-q:v', '4', outJpg]);
    if (!ff.ok || !fs.existsSync(outJpg)) return { ok: false, error: ff.stderr?.slice(0, 300) || 'ffmpeg 无输出' };
    return { ok: true };
  }

  /** 把 [start,end] 切成 chunks 段（每段边界取两位小数）。 */
  function planChunks(duration, chunks) {
    const dur = Number(duration) || 0;
    const k = Math.max(1, Math.min(Math.round(Number(chunks) || 1), Math.floor(dur / 1.5) || 1));
    const step = dur / k;
    const out = [];
    for (let i = 0; i < k; i += 1) {
      out.push({
        index: i + 1,
        start: Number((i * step).toFixed(2)),
        end: Number((i === k - 1 ? dur : (i + 1) * step).toFixed(2))
      });
    }
    return out;
  }

  /** 在 [start,end] 内补齐到 want 个时间点（已有的保留，不够就段内均匀补）。 */
  function fillTimes(times, want, start, end) {
    const n = Math.max(1, Math.round(Number(want) || 1));
    const uniq = [...new Set((times || []).map((t) => Number(Number(t).toFixed(2))))]
      .filter((t) => Number.isFinite(t) && t >= start - 0.001 && t <= end + 0.001)
      .sort((a, b) => a - b);
    if (uniq.length >= n) return uniq.slice(0, n);
    const merged = [...uniq];
    const span = Math.max(0.1, end - start);
    const guard = Math.max(0.05, span / (n * 4));
    for (let i = 0; i < n && merged.length < n; i += 1) {
      const t = Number((start + span * ((i + 0.5) / n)).toFixed(2));
      if (!merged.some((x) => Math.abs(x - t) < guard)) merged.push(t);
    }
    let guardRound = 0;
    while (merged.length < n && guardRound < 50) {
      merged.push(Number((start + span * ((merged.length + 0.5) / n)).toFixed(2)));
      guardRound += 1;
    }
    merged.sort((a, b) => a - b);
    return merged.slice(0, n);
  }

  /**
   * 分段九宫格：视频按时长切 K 段，每段各出一张网格。
   *
   * 为什么分：单张九宫格只覆盖「选出来的 9 个瞬间」，长视频里大部分内容看不到；
   * 分段后每段都有自己的 9 帧，模型能在同一轮里对比开头/中间/结尾。
   * 场景变化点只算一次，按区间分配给各段；某段没有变化点就在段内均匀铺。
   */
  async function buildVideoGridChunks({ file, wantPerChunk, chunks, tileWidth = 240, strategy = 'overview', dir }) {
    const meta = describeProbe(await probeMedia(file));
    const duration = meta.durationSec > 0.05 ? meta.durationSec : 0;
    const want = Math.max(2, Math.min(12, Math.round(Number(wantPerChunk) || 9)));
    const grid = gridForFrames(want);

    if (!duration || chunks <= 1) {
      const one = await buildVideoGrid({ file, want, tileWidth, strategy, dir });
      if (!one.ok) return one;
      return {
        ...one,
        grids: [{ index: 1, start: 0, end: duration, times: one.timestamps || [], outJpg: one.outJpg, mode: one.mode, candidates: one.candidates || 0 }],
        duration
      };
    }

    const ranges = planChunks(duration, chunks);
    let candidates = [];
    for (const threshold of [20, 10, 5]) {
      candidates = await sceneCandidates(file, { minScore: threshold });
      if (candidates.length >= 2) break;
    }

    const grids = [];
    for (const range of ranges) {
      const { start, end, index } = range;
      const inRange = candidates.filter((c) => c.t >= start && c.t < (index === ranges.length ? duration + 1 : end));
      const picked = inRange.length >= 2 ? pickTimestamps(inRange, want, strategy) : [];
      const times = fillTimes(picked, want, start, end);
      const outJpg = path.join(dir, `grid-${index}.jpg`);
      const rendered = await renderAtTimes(file, times, grid, tileWidth, outJpg);
      if (!rendered.ok) return { ok: false, error: `第 ${index} 段抽帧失败：${rendered.error}` };
      grids.push({
        index, start, end, times, outJpg,
        mode: inRange.length >= 2 ? 'scene' : 'uniform',
        candidates: inRange.length
      });
    }

    return {
      ok: true,
      mode: 'chunks',
      grids,
      candidates: candidates.length,
      duration,
      width: meta.width,
      height: meta.height,
      frames: meta.frames
    };
  }

  async function uniformGrid({ file, want, tileWidth, grid, outJpg }) {
    const meta = describeProbe(await probeMedia(file));
    const duration = meta.durationSec > 0.05 ? meta.durationSec : 0;
    const vf = duration > 0.05
      ? `fps=${Math.max(0.01, Math.min(30, want / duration)).toFixed(4)},${tileFilter(grid, { tileWidth })}`
      : tileFilter(grid, { tileWidth });
    const ff = await run(ffmpeg, ['-v', 'error', '-y', '-i', file, '-vf', vf, '-frames:v', '1', '-q:v', '4', outJpg]);
    return ff.ok && fs.existsSync(outJpg)
      ? { ok: true, outJpg, mode: 'uniform', timestamps: [] }
      : { ok: false, error: ff.stderr?.slice(0, 300) || 'ffmpeg 无输出' };
  }

  /**
   * B 站元信息（官方 API 兜底）。
   *
   * 为什么需要：机房/云服务器 IP 直连 www.bilibili.com 会被 412 拦，
   * yt-dlp 因此完全不可用（实测 Ubuntu 云主机）。api.bilibili.com 仍然可用。
   */
  async function biliApiInfo(input) {
    const raw = String(input || '');
    const bv = (/BV[0-9A-Za-z]{8,}/.exec(raw) || [])[0];
    let bvid = bv;
    if (!bvid) {
      // b23.tv 短链：跟随跳转拿到真实 URL
      try {
        const r = await fetch(raw, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } });
        bvid = (/BV[0-9A-Za-z]{8,}/.exec(r.url) || [])[0];
      } catch { /* 下面统一报错 */ }
    }
    if (!bvid) return { ok: false, error: '解析不出 BV 号' };
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    try {
      // 关键：不先拿 buvid3 的话，api.bilibili.com 同样返回 412（实测）。
      // /x/frontend/finger/spi 会给一对 b_3/b_4，拿 b_3 当 buvid3 即可。
      let buvid3 = '';
      try {
        const spi = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
          headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
          signal: AbortSignal.timeout(10_000)
        });
        const spiBody = await spi.json();
        buvid3 = String(spiBody?.data?.b_3 || '');
      } catch { /* 拿不到就退回无 cookie 请求 */ }

      const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        headers: {
          'user-agent': UA,
          referer: 'https://www.bilibili.com/',
          ...(biliCookieHeader || buvid3 ? { cookie: [biliCookieHeader, buvid3 ? `buvid3=${buvid3}` : ''].filter(Boolean).join('; ') } : {})
        },
        signal: AbortSignal.timeout(15_000)
      });
      const body = await res.json();
      if (body?.code !== 0 || !body?.data) return { ok: false, error: `API 返回 code=${body?.code} ${body?.message || ''}` };
      const d = body.data;
      return {
        ok: true,
        info: {
          bvid: d.bvid,
          aid: d.aid,
          cid: d.cid,
          title: d.title,
          uploader: d.owner?.name || '',
          duration: Number(d.duration) || 0,
          uploadDate: d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 10) : '',
          viewCount: d.stat?.view ?? null,
          description: String(d.desc || '').slice(0, 400),
          cover: d.pic || ''
        }
      };
    } catch (error) {
      return { ok: false, error: `API 请求失败：${error?.message ?? error}` };
    }
  }

  /** 直链下载（限体积）。 */
  async function downloadDirect(url, dir) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxDownload) return { ok: false, error: `文件太大（${Math.round(len / 1024 / 1024)}MB > ${maxDownloadMb}MB）` };
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxDownload) return { ok: false, error: `下载超限（>${maxDownloadMb}MB）` };
      chunks.push(chunk);
    }
    const ext = path.extname(new URL(url).pathname) || '.bin';
    const file = path.join(dir, `direct${ext}`);
    fs.writeFileSync(file, Buffer.concat(chunks));
    return { ok: true, file };
  }

  /** B 站下载：先走官方 API（机房 IP 也能用），失败再退回 yt-dlp。 */
  async function downloadBili(url, dir) {
    // ① 官方 API 通道
    try {
      await bili.ensureBuvid?.();
      const m = await bili.meta(url);
      const dest = path.join(dir, 'bili.mp4');
      const dl = await bili.download(m, dest);
      return { ok: true, file: dest, source: 'bilibili-api', meta: m, bytes: dl.bytes };
    } catch (apiError) {
      // ② 退路：yt-dlp（需要能访问网页，家宽/代理环境下可用）
      const dlDir = path.join(dir, 'dl');
      fs.mkdirSync(dlDir, { recursive: true });
      const cookieFile = biliCookiesFile && fs.existsSync(biliCookiesFile) ? biliCookiesFile : '';
      const args = ['--ffmpeg-location', path.dirname(ffmpeg),
        ...buildBiliDlpArgs({ cookieFile, maxDownload, outTemplate: path.join(dlDir, 'media.%(ext)s'), url })];
      const dl = await run(ytdlp, args, 180_000);
      if (!dl.ok) {
        return {
          ok: false,
          error: `B 站下载失败：API ${String(apiError?.message ?? apiError).slice(0, 120)}；yt-dlp ${dl.stderr.slice(0, 160)}`
        };
      }
      const names = fs.readdirSync(dlDir).map((n) => path.join(dlDir, n));
      const file = pickVideoFile(names);
      return file ? { ok: true, file, source: 'yt-dlp' } : { ok: false, error: '下载后没找到视频文件' };
    }
  }

  return { run, probeMedia, sceneCandidates, buildVideoGrid, buildVideoGridChunks, planChunks, fillTimes, downloadDirect, downloadBili, biliApiInfo, bili, ffmpeg, ffprobe, ytdlp };
}







