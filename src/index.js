#!/usr/bin/env node
// 「看视频」MCP —— 把 B 站链接变成模型能吃的东西。
//
// 为什么需要它：模型只能处理文本和图片，给一个视频链接时它只能抓到网页标题。
// 这里把链接变成模型能吃的东西：
//   1. yt-dlp 拿元数据（标题/UP 主/时长/简介/是否有字幕）
//   2. 下载一个低清版本（≤480p，限体积），ffmpeg 抽 N 帧拼成网格图
//   3. 顺便尝试下载字幕（B 站 AI 字幕通常要登录，见 cookies 说明），转成纯文本
//
// 环境变量（都可选）：
//   VIDEO_YTDLP    yt-dlp 可执行文件路径，默认 `yt-dlp`
//   VIDEO_FFMPEG   ffmpeg 可执行文件路径，默认 `ffmpeg`
//   VIDEO_COOKIES  cookies.txt 路径（用于取字幕），默认 ~/.config/mcp-video-learn/cookies.txt
//   VIDEO_AUDIT    审计日志路径，默认 ~/.cache/mcp-video-learn/audit.jsonl
//   VIDEO_MAX_MB   单次下载体积上限（MB），默认 60
//
// 安全边界：只接受 bilibili.com / b23.tv 链接；单次下载 ≤VIDEO_MAX_MB；步骤超时。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { normalizeBiliUrl, fmtDuration, subtitlesToText, gridFor, pickVideoFile } from './lib.js';
import { guessKind, pickFrames, gridForFrames, tileFilter, isUnderRoots, isDirectMediaUrl, describeProbe } from './media.js';
import { pickTimestamps } from './filmstrip.js';
import { makePipeline } from './pipeline.js';

const pipe = makePipeline();

const YTDLP = process.env.VIDEO_YTDLP || 'yt-dlp';
const FFMPEG = process.env.VIDEO_FFMPEG || 'ffmpeg';
const COOKIES = process.env.VIDEO_COOKIES
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'mcp-video-learn', 'cookies.txt');
const AUDIT = process.env.VIDEO_AUDIT
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'mcp-video-learn', 'audit.jsonl');
const MAX_DOWNLOAD_MB = Math.max(1, Number(process.env.VIDEO_MAX_MB) || 60);
const MAX_DOWNLOAD = MAX_DOWNLOAD_MB * 1024 * 1024;
const STEP_TIMEOUT_MS = 120_000;

// 本地文件白名单：默认当前目录 + 临时目录，可用 VIDEO_ALLOW_ROOTS 追加（用路径分隔符隔开）。
const ALLOW_ROOTS = [
  process.cwd(),
  os.tmpdir(),
  ...String(process.env.VIDEO_ALLOW_ROOTS || '').split(path.delimiter).filter(Boolean)
];

function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* 审计失败不影响主流程 */ }
}

function run(cmd, args, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    const chunks = [];
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    const errChunks = [];
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

function ytdlpArgs(extra = []) {
  const args = ['--no-warnings', '--no-playlist', '--ffmpeg-location', path.dirname(FFMPEG)];
  args.push(
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--add-header',
    'Referer:https://www.bilibili.com/',
    '--extractor-args',
    'bilibili:prefer_multi_flv=false'
  );
  // B 站登录态：VIDEO_COOKIES 优先，其次 BILI_COOKIES（方便直接复用导出的小号 cookie）
  const cookieFile = [process.env.BILI_COOKIES, COOKIES].find((p) => p && fs.existsSync(p));
  if (cookieFile) args.push('--cookies', cookieFile);
  return [...args, ...extra];
}

/** ffprobe 出 JSON（流 + 容器信息）。 */
async function probeMedia(file) { return pipe.probeMedia(file); }

/** 把直链下载到临时文件（限制体积，避免变成通用下载器）。 */
async function downloadDirect(url, dir) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOWNLOAD) return { ok: false, error: `文件太大（${Math.round(len / 1024 / 1024)}MB > ${MAX_DOWNLOAD_MB}MB）` };
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_DOWNLOAD) return { ok: false, error: `下载超限（>${MAX_DOWNLOAD_MB}MB）` };
    chunks.push(chunk);
  }
  const ext = path.extname(new URL(url).pathname) || '.bin';
  const file = path.join(dir, `direct${ext}`);
  fs.writeFileSync(file, Buffer.concat(chunks));
  return { ok: true, file };
}

/**
 * 把三种输入统一成「本地可读的媒体文件」：
 *   · B 站链接 → yt-dlp 下 480p
 *   · 直接媒体直链 → fetch（限体积）
 *   · 本地路径 → 必须落在白名单目录内
 */
async function resolveMedia(input, dir) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: '空输入' };

  if (/^https?:\/\//i.test(raw)) {
    if (normalizeBiliUrl(raw)) {
      const dlDir = path.join(dir, 'dl');
      fs.mkdirSync(dlDir, { recursive: true });
      const dl = await run(YTDLP, ytdlpArgs([
        '-f', 'bv*[height<=480]+ba/b[height<=480]/worst',
        '--max-filesize', String(MAX_DOWNLOAD),
        '-o', path.join(dlDir, 'media.%(ext)s'), raw
      ]), 180_000);
      if (!dl.ok) return { ok: false, error: `B 站下载失败：${dl.stderr.slice(0, 200)}` };
      const names = fs.readdirSync(dlDir).map((n) => path.join(dlDir, n));
      const file = pickVideoFile(names);
      return file ? { ok: true, file, source: 'bilibili' } : { ok: false, error: '下载后没找到视频文件' };
    }
    if (!isDirectMediaUrl(raw)) return { ok: false, error: '拒绝：只支持 B 站链接或 .gif/.webp/.mp4 这类媒体直链' };
    const got = await downloadDirect(raw, dir);
    return got.ok ? { ok: true, file: got.file, source: 'direct' } : { ok: false, error: got.error };
  }

  const abs = path.resolve(raw);
  if (!isUnderRoots(abs, ALLOW_ROOTS)) return { ok: false, error: `拒绝：本地路径不在白名单目录内（${ALLOW_ROOTS.join(' , ')}）` };
  if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在：${abs}` };
  return { ok: true, file: abs, source: 'local' };
}

/**
 * 用 ffmpeg 的场景检测拿到「画面发生明显变化」的时间点。
 * 解析 stderr 里的 showinfo 行（pts_time），失败就返回空数组走均匀采样。
 */
async function sceneCandidates(file, opts = {}) { return pipe.sceneCandidates(file, opts); }
async function buildVideoGrid(args) { return pipe.buildVideoGrid(args); }

const server = new McpServer({ name: 'video-learn', version: '0.3.0' });

server.tool(
  'bili_video_info',
  '看一个 B 站视频的元信息（不下载）：标题、UP 主、时长、简介摘要、有没有字幕。用于判断值不值得看。',
  { url: z.string().describe('B 站链接（含 b23.tv 短链）') },
  async ({ url }) => {
    const target = normalizeBiliUrl(url);
    if (!target) return { content: [{ type: 'text', text: '拒绝：只支持 bilibili.com / b23.tv 链接' }], isError: true };

    // 先走官方 API：机房 IP 直连网页会被 412 拦，但 api.bilibili.com 可用。
    const api = await pipe.biliApiInfo(target);
    if (api.ok) {
      audit({ tool: 'info', url: target, ok: true, via: 'api' });
      return { content: [{ type: 'text', text: JSON.stringify({ ...api.info, via: 'api' }, null, 2) }] };
    }

    const res = await run(YTDLP, ytdlpArgs(['--dump-single-json', '--skip-download', target]));
    audit({ tool: 'info', url: target, ok: res.ok });
    if (!res.ok) {
      const hint = /412/.test(res.stderr) ? '（机房 IP 直连 B 站常被 412 拦，API 也没取到；可换家宽网络，或用基于 API 的 mcp-bili）' : '';
      return { content: [{ type: 'text', text: `获取失败：${res.stderr.slice(0, 300)}${hint}` }], isError: true };
    }
    let info;
    try { info = JSON.parse(res.stdout); } catch { return { content: [{ type: 'text', text: '解析失败：yt-dlp 输出不是 JSON' }], isError: true }; }
    const subs = Object.keys({ ...(info.subtitles ?? {}), ...(info.automatic_captions ?? {}) });
    const payload = {
      title: info.title ?? '',
      uploader: info.uploader ?? '',
      duration: fmtDuration(info.duration),
      uploadDate: info.upload_date ?? '',
      viewCount: info.view_count ?? null,
      description: String(info.description ?? '').slice(0, 400),
      subtitleLangs: subs,
      hasSubtitle: subs.length > 0
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

server.tool(
  'bili_video_watch',
  '真正“看”一个 B 站视频：走官方 API 下载低清流（机房 IP 也可用）→ 抽 N 帧拼成网格 + 字幕文本。'
  + '适合回答“这个视频讲了什么”。注意：只有字幕能反映台词/讲解，纯语音内容会缺失。',
  { url: z.string().describe('B 站链接'), frames: z.number().int().min(4).max(12).optional().describe('抽几帧，默认 9') },
  async ({ url, frames }) => {
    const target = normalizeBiliUrl(url);
    if (!target) return { content: [{ type: 'text', text: '拒绝：只支持 bilibili.com / b23.tv 链接' }], isError: true };
    const want = pickFrames('video', frames);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-learn-'));
    try {
      // 1) 元信息 + 字幕（API 通道，不抓网页）
      let meta = null;
      try {
        meta = await pipe.bili.meta(target);
      } catch (error) {
        audit({ tool: 'watch', url: target, ok: false, stage: 'meta', err: String(error?.message ?? error) });
        return { content: [{ type: 'text', text: `获取元信息失败：${error?.message ?? error}` }], isError: true };
      }
      const sub = await pipe.bili.subtitles(meta);
      const subtitleText = String(sub.text || '').slice(0, 20000);

      // 2) 下载（API 优先，失败自动回退 yt-dlp）
      const dl = await pipe.downloadBili(target, dir);
      audit({ tool: 'watch', url: target, ok: dl.ok, source: dl.source, bytes: dl.bytes, subChars: subtitleText.length });
      if (!dl.ok) return { content: [{ type: 'text', text: dl.error }], isError: true };

      // 3) 网格
      const grid = gridFor(want);
      const built = await pipe.buildVideoGrid({ file: dl.file, want, strategy: 'overview', dir });
      if (!built.ok) return { content: [{ type: 'text', text: `抽帧失败：${built.error}` }], isError: true };

      const header = [
        `标题：${meta.title}`,
        `UP 主：${meta.uploader}`,
        `时长：${fmtDuration(meta.duration)}`,
        `来源：${dl.source}（${Math.round((dl.bytes || 0) / 1048576)}MB）`,
        `画面：${want} 帧拼成 ${grid.cols}×${grid.rows} 网格（${built.mode === 'scene' ? '场景变化取帧' : '均匀采样'}）`,
        subtitleText ? `字幕：已获取 ${subtitleText.length} 字（${(sub.langs || []).slice(0, 3).join('/')}）` : '字幕：没有可用字幕轨',
        subtitleText ? `\n【字幕全文】\n${subtitleText}` : ''
      ].filter(Boolean).join('\n');

      return {
        content: [
          { type: 'text', text: header },
          { type: 'image', data: fs.readFileSync(built.outJpg).toString('base64'), mimeType: 'image/jpeg' }
        ]
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

server.tool(
  'media_frames',
  '把任意“动的东西”变成模型能看懂的帧网格：本地 GIF/WebP/视频、媒体直链、或 B 站链接。'
  + '适合识别动图表情包、看短视频、检查本地素材。返回元信息（尺寸/帧数/时长）+ 一张网格图。',
  {
    input: z.string().describe('本地路径、媒体直链（.gif/.webp/.mp4…）或 B 站链接'),
    frames: z.number().int().min(1).max(12).optional().describe('抽几帧；动图默认 6，视频默认 9'),
    tileWidth: z.number().int().min(64).max(640).optional().describe('每帧宽度（像素），默认 240'),
    strategy: z.enum(['overview', 'recent']).optional()
      .describe('视频取帧策略：overview 均匀覆盖全程（默认）；recent 取最近 N 个变化瞬间（FIFO 队列快照）')
  },
  async ({ input, frames, tileWidth, strategy }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-learn-'));
    try {
      const resolved = await resolveMedia(input, dir);
      if (!resolved.ok) return { content: [{ type: 'text', text: `失败：${resolved.error}` }], isError: true };

      const kind = guessKind(resolved.file);
      const want = pickFrames(kind, frames);
      const grid = gridForFrames(want);

      const probe = await probeMedia(resolved.file);
      if (!probe) return { content: [{ type: 'text', text: '失败：ffprobe 读不出这个文件（可能不是媒体）' }], isError: true };
      const meta = describeProbe(probe);

      let outJpg = path.join(dir, 'grid.jpg');
      let mode = 'uniform';
      let timestamps = [];
      let built = null;   // header 里要用，提到块外

      // 动图 WebP 也要走 buildVideoGrid：ffmpeg 4.x 只能读静态 WebP，
      // 动图得靠 sharp 逐帧解码（pipeline 里按页数分流）。
      if (kind === 'video' || /\.webp$/i.test(resolved.file)) {
        // 视频：走「场景变化 → FIFO 队列」这条主路，拿不到变化点再退回均匀采样
        built = await buildVideoGrid({ file: resolved.file, want, tileWidth, strategy: strategy ?? 'overview', dir });
        if (!built.ok) return { content: [{ type: 'text', text: `抽帧失败：${built.error}` }], isError: true };
        outJpg = built.outJpg;
        mode = built.mode;
        timestamps = built.timestamps || [];
      } else {
        // 动图/静态图：按时长均匀铺满（动图本身就是一个短循环，均匀采样最合适）
        const duration = meta.durationSec > 0.05 ? meta.durationSec : 0;
        const vf = duration > 0.05
          ? `fps=${Math.max(0.01, Math.min(30, want / duration)).toFixed(4)},${tileFilter(grid, { tileWidth })}`
          : `select='not(mod(n\\,${Math.max(1, Math.round((meta.frames || want) / want))}))',${tileFilter(grid, { tileWidth })}`;
        const ff = await run(FFMPEG, ['-v', 'error', '-y', '-i', resolved.file, '-vf', vf, '-frames:v', '1', '-q:v', '4', outJpg]);
        if (!ff.ok || !fs.existsSync(outJpg)) {
          return { content: [{ type: 'text', text: `抽帧失败：${ff.stderr?.slice(0, 200) || 'ffmpeg 无输出'}` }], isError: true };
        }
      }

      audit({ tool: 'media_frames', source: resolved.source, kind, ok: true, frames: want, mode });

      const isSharp = mode === 'webp-sharp';
      const sizeText = isSharp
        ? `${built.width}×${built.height}`
        : `${meta.width}×${meta.height}${meta.frames ? ` · 共 ${meta.frames} 帧` : ''}${meta.durationSec ? ` · ${meta.durationSec} 秒` : ''}`;
      const frameText = isSharp
        ? `取帧：sharp 逐帧解码（共 ${built.pages} 页，取 ${built.frames} 帧；ffmpeg 4.x 只能读静态 WebP）`
        : mode === 'scene'
          ? `取帧：场景变化检测（${strategy === 'recent' ? 'FIFO 队列最近窗口' : '全程均匀覆盖'}），命中 ${timestamps.length} 个变化点`
          : '取帧：均匀采样（没有检测到明显的场景切换）';
      const header = [
        `来源：${resolved.source}${resolved.source === 'local' ? `（${path.basename(resolved.file)}）` : ''}`,
        `类型：${isSharp ? '动图 WebP（sharp 解码）' : kind + (meta.animated ? '（动图/视频）' : meta.still ? '（静态图）' : '')}`,
        `尺寸：${sizeText}`,
        `画面：${want} 帧拼成 ${grid.cols}×${grid.rows} 网格（行优先 左上→右下）`,
        frameText
      ].join('\n');

      return {
        content: [
          { type: 'text', text: header },
          { type: 'image', data: fs.readFileSync(outJpg).toString('base64'), mimeType: 'image/jpeg' }
        ]
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

audit({ tool: 'startup', cookies: fs.existsSync(COOKIES) });
console.error(`[video-learn] ready — cookies=${fs.existsSync(COOKIES) ? 'yes' : 'no'}`);
await server.connect(new StdioServerTransport());



