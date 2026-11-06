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
   * 场景变化候选点：解析 ffmpeg 的 showinfo（pts_time）。
   * 失败返回空数组，调用方会退回均匀采样。
   */
  async function sceneCandidates(file, { minScore = 0.25, timeoutMs = 180_000 } = {}) {
    const res = await run(ffmpeg, [
      '-v', 'info', '-i', file,
      '-vf', `select='gt(scene,${minScore})',showinfo`,
      '-an', '-f', 'null', '-'
    ], timeoutMs);
    const out = [];
    const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
    let m;
    const text = String(res.stderr || '');
    while ((m = re.exec(text)) !== null) {
      const t = Number(m[1]);
      if (Number.isFinite(t)) out.push({ t, score: minScore });
    }
    const seen = new Set();
    return out.filter((c) => {
      const k = c.t.toFixed(2);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => a.t - b.t);
  }

  /**
   * 生成帧网格。
   * 主路径：场景变化 → FIFO 队列（overview/recent 两种取用）
   * 退路：场景检测拿不到点时按 fps 均匀采样
   */
  async function buildVideoGrid({ file, want, tileWidth = 240, strategy = 'overview', dir }) {
    const grid = gridForFrames(want);
    const outJpg = path.join(dir, 'grid.jpg');
    const candidates = await sceneCandidates(file);
    const times = pickTimestamps(candidates, want, strategy);

    if (times.length >= Math.min(2, want)) {
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

  return { run, probeMedia, sceneCandidates, buildVideoGrid, downloadDirect, downloadBili, ffmpeg, ffprobe, ytdlp };
}
