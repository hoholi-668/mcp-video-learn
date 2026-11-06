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

export function makePipeline({
  ffmpeg = process.env.VIDEO_FFMPEG || 'ffmpeg',
  ytdlp = process.env.VIDEO_YTDLP || 'yt-dlp',
  maxDownloadMb = Number(process.env.VIDEO_MAX_MB) || 60,
  stepTimeoutMs = 120_000,
  allowRoots = [process.cwd(), os.tmpdir()],
  cookiesPath = ''
} = {}) {
  const maxDownload = maxDownloadMb * 1024 * 1024;
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

    // ffmpeg 4.x 的 webp 解码器只认静态 webp：动图 webp 会解出 0×0。
    // 与其静默出一张黑图，不如明确告诉调用方「这个文件我解不开，以及为什么」。
    if (meta.width <= 0 || meta.height <= 0) {
      const isWebp = /\.webp$/i.test(String(file));
      return {
        ok: false,
        error: isWebp
          ? '解不开这个 WebP：当前 ffmpeg 版本只支持静态 WebP，动图 WebP 需要 ffmpeg 6.x 以上'
            + '（或先用 webp-tools 的 dwebp/img2webp 转成 GIF）。'
          : 'ffmpeg 解不开这个文件（探测不到画面尺寸，可能已损坏或不是媒体）'
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
          ...(buvid3 ? { cookie: `buvid3=${buvid3}` } : {})
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

  /** B 站链接用 yt-dlp 下 480p。 */
  async function downloadBili(url, dir) {
    const dlDir = path.join(dir, 'dl');
    fs.mkdirSync(dlDir, { recursive: true });
    const args = ['--no-warnings', '--no-playlist', '--ffmpeg-location', path.dirname(ffmpeg)];
    if (cookiesPath && fs.existsSync(cookiesPath)) args.push('--cookies', cookiesPath);
    args.push('-f', 'bv*[height<=480]+ba/b[height<=480]/worst', '--max-filesize', String(maxDownload),
      '-o', path.join(dlDir, 'media.%(ext)s'), url);
    const dl = await run(ytdlp, args, 180_000);
    if (!dl.ok) return { ok: false, error: `B 站下载失败：${dl.stderr.slice(0, 300)}` };
    const names = fs.readdirSync(dlDir).map((n) => path.join(dlDir, n));
    const file = pickVideoFile(names);
    return file ? { ok: true, file, source: 'bilibili' } : { ok: false, error: '下载后没找到视频文件' };
  }

  return { run, probeMedia, sceneCandidates, buildVideoGrid, downloadDirect, downloadBili, biliApiInfo, ffmpeg, ffprobe, ytdlp };
}



