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

const YTDLP = process.env.VIDEO_YTDLP || 'yt-dlp';
const FFMPEG = process.env.VIDEO_FFMPEG || 'ffmpeg';
const COOKIES = process.env.VIDEO_COOKIES
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'mcp-video-learn', 'cookies.txt');
const AUDIT = process.env.VIDEO_AUDIT
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'mcp-video-learn', 'audit.jsonl');
const MAX_DOWNLOAD_MB = Math.max(1, Number(process.env.VIDEO_MAX_MB) || 60);
const MAX_DOWNLOAD = MAX_DOWNLOAD_MB * 1024 * 1024;
const STEP_TIMEOUT_MS = 120_000;

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
  if (fs.existsSync(COOKIES)) args.push('--cookies', COOKIES);
  return [...args, ...extra];
}

const server = new McpServer({ name: 'video-learn', version: '0.1.0' });

server.tool(
  'bili_video_info',
  '看一个 B 站视频的元信息（不下载）：标题、UP 主、时长、简介摘要、有没有字幕。用于判断值不值得看。',
  { url: z.string().describe('B 站链接（含 b23.tv 短链）') },
  async ({ url }) => {
    const target = normalizeBiliUrl(url);
    if (!target) return { content: [{ type: 'text', text: '拒绝：只支持 bilibili.com / b23.tv 链接' }], isError: true };
    const res = await run(YTDLP, ytdlpArgs(['--dump-single-json', '--skip-download', target]));
    audit({ tool: 'info', url: target, ok: res.ok });
    if (!res.ok) return { content: [{ type: 'text', text: `获取失败：${res.stderr.slice(0, 300)}` }], isError: true };
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
  '真正“看”一个 B 站视频：下载低清版 → 抽 N 帧拼成网格（画面）+ 能拿到的话附上字幕文本（内容）。'
  + '适合回答“这个视频讲了什么”。注意：只有字幕能反映台词/讲解，纯语音内容会缺失；下载可能花十几秒。',
  { url: z.string().describe('B 站链接'), frames: z.number().int().min(4).max(12).optional().describe('抽几帧，默认 9') },
  async ({ url, frames }) => {
    const target = normalizeBiliUrl(url);
    if (!target) return { content: [{ type: 'text', text: '拒绝：只支持 bilibili.com / b23.tv 链接' }], isError: true };
    const { want, cols, rows } = gridFor(frames ?? 9);

    const metaRes = await run(YTDLP, ytdlpArgs(['--dump-single-json', '--skip-download', target]));
    if (!metaRes.ok) {
      audit({ tool: 'watch', url: target, ok: false, stage: 'meta' });
      return { content: [{ type: 'text', text: `获取元信息失败：${metaRes.stderr.slice(0, 300)}` }], isError: true };
    }
    let info = {};
    try { info = JSON.parse(metaRes.stdout); } catch { /* 后面还能继续抽帧 */ }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-learn-'));
    try {
      // 1) 字幕（失败无所谓，B 站 AI 字幕多数要登录）
      const subDir = path.join(dir, 'subs');
      fs.mkdirSync(subDir, { recursive: true });
      await run(YTDLP, ytdlpArgs([
        '--skip-download', '--write-subs', '--write-auto-subs',
        '--sub-langs', 'zh-Hans,zh-CN,zh,ai-zh,en', '--convert-subs', 'vtt',
        '-o', path.join(subDir, '%(id)s.%(ext)s'), target
      ]));
      let subtitleText = '';
      try {
        const files = fs.readdirSync(subDir).filter((f) => f.endsWith('.vtt'));
        for (const f of files) {
          const text = subtitlesToText(fs.readFileSync(path.join(subDir, f), 'utf8'));
          if (text.length > subtitleText.length) subtitleText = text;
        }
      } catch { /* 忽略 */ }
      subtitleText = subtitleText.slice(0, 6000);

      // 2) 视频（低清 + 限体积），输出到独立子目录，用 %(ext)s 因为合并后可能是 mp4/mkv
      const dlDir = path.join(dir, 'dl');
      fs.mkdirSync(dlDir, { recursive: true });
      const dl = await run(YTDLP, ytdlpArgs([
        '-f', 'bv*[height<=480]+ba/b[height<=480]/worst',
        '--max-filesize', String(MAX_DOWNLOAD),
        '-o', path.join(dlDir, 'video.%(ext)s'), target
      ]), 180_000);
      const names = fs.existsSync(dlDir)
        ? fs.readdirSync(dlDir)
            .map((name) => path.join(dlDir, name))
            .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)
        : [];
      const videoFile = pickVideoFile(names);
      audit({ tool: 'watch', url: target, ok: dl.ok && !!videoFile, stage: 'download', subChars: subtitleText.length });
      if (!dl.ok || !videoFile) {
        return { content: [{ type: 'text', text: `视频下载失败（${dl.stderr?.slice(0, 200) || '无输出'}）；字幕${subtitleText ? '已拿到' : '也没有'}。` }], isError: true };
      }

      // 3) 抽帧拼图：fps = 帧数 / 时长，让抽出的帧均匀铺满整段
      const duration = Number(info.duration) > 0 ? Number(info.duration) : 60;
      const fps = Math.max(0.01, Math.min(30, want / Math.max(1, duration)));
      const outJpg = path.join(dir, 'strip.jpg');
      const ff = await run(FFMPEG, [
        '-v', 'error', '-y', '-i', videoFile,
        '-vf', `fps=${fps.toFixed(4)},scale=320:-1:flags=lanczos,tile=${cols}x${rows}:padding=4:margin=4:color=white`,
        '-frames:v', '1', '-q:v', '4', outJpg
      ]);
      if (!ff.ok || !fs.existsSync(outJpg)) {
        return { content: [{ type: 'text', text: `抽帧失败：${ff.stderr?.slice(0, 200) || 'ffmpeg 无输出'}` }], isError: true };
      }

      const header = [
        `标题：${info.title ?? '(未知)'}`,
        `UP 主：${info.uploader ?? '(未知)'}`,
        `时长：${fmtDuration(duration)}`,
        `画面：已抽 ${want} 帧拼成 ${cols}×${rows} 网格（行优先 左上→右下，均匀覆盖整段）`,
        subtitleText
          ? `字幕：已获取 ${subtitleText.length} 字，全文在下方`
          : '字幕：没有拿到（B 站 AI 字幕通常需要登录 cookies；纯语音内容会缺失）',
        subtitleText ? `\n【字幕全文】\n${subtitleText}` : ''
      ].filter(Boolean).join('\n');

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
