#!/usr/bin/env node
// MCP 协议层自测：真的把服务当 MCP server 拉起来，用官方客户端调工具。
// 覆盖：工具清单、B 站元信息（API 兜底）、本地 GIF 出图、白名单外路径被拒、假文件被拒。
//
// 需要能解析 @modelcontextprotocol/sdk —— 设置 NODE_PATH 指向已装依赖的目录，
// 或在本仓库 npm install。
//
// 用法：VIDEO_ALLOW_ROOTS=<fixtures目录> node scripts/selftest-mcp.mjs [fixturesDir]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makePipeline } from '../src/pipeline.js';

const fixtures = process.argv[2] || process.env.VIDEO_ALLOW_ROOTS || os.tmpdir();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-selftest-'));
const pipe = makePipeline();

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); return true; }
  fail += 1; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

// 准备一个 GIF 供 media_frames 用
const gif = path.join(outDir, 'anim.gif');
const mp4 = path.join(outDir, 'cuts.mp4');
const inputs = [];
for (const c of ['red', 'green', 'blue', 'yellow']) {
  inputs.push('-f', 'lavfi', '-i', `color=${c}:size=320x240:rate=10:duration=1`);
}
await pipe.run(pipe.ffmpeg, ['-v', 'error', '-y', ...inputs,
  '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', mp4]);
await pipe.run(pipe.ffmpeg, ['-v', 'error', '-y', '-i', mp4, '-vf', 'fps=8,scale=160:-1', gif]);

const client = new Client({ name: 'selftest', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(import.meta.dirname, '../src/index.js')],
  env: {
    ...process.env,
    VIDEO_ALLOW_ROOTS: outDir,
    VIDEO_YTDLP: process.env.VIDEO_YTDLP || 'yt-dlp',
    VIDEO_FFMPEG: process.env.VIDEO_FFMPEG || 'ffmpeg'
  }
});

function textOf(result) {
  return (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

try {
  await client.connect(transport);
  console.log('\n[1] 工具清单');
  const tools = await client.listTools();
  const names = (tools.tools || []).map((t) => t.name).sort();
  ok('三个工具都在', ['bili_video_info', 'bili_video_watch', 'media_frames'].every((n) => names.includes(n)), names.join(', '));

  console.log('\n[2] media_frames：本地 GIF');
  const gifRes = await client.callTool({ name: 'media_frames', arguments: { input: gif, frames: 6 } });
  const gifText = textOf(gifRes);
  const hasImage = (gifRes.content || []).some((c) => c.type === 'image');
  ok('返回了图片', hasImage);
  ok('文本里有网格描述', /网格/.test(gifText), gifText.split('\n')[0] || '');
  ok('没有报错', !gifRes.isError, gifRes.isError ? gifText.slice(0, 80) : '');

  console.log('\n[3] media_frames：白名单外路径');
  const deny = await client.callTool({ name: 'media_frames', arguments: { input: '/etc/passwd' } });
  ok('被拒绝且给出原因', deny.isError && /白名单/.test(textOf(deny)), textOf(deny).slice(0, 60));

  console.log('\n[4] media_frames：假视频');
  const fake = path.join(outDir, 'fake.mp4');
  fs.writeFileSync(fake, 'not a video'.repeat(100));
  const fakeRes = await client.callTool({ name: 'media_frames', arguments: { input: fake } });
  ok('假视频报错', fakeRes.isError, textOf(fakeRes).slice(0, 70));

  console.log('\n[5] bili_video_info：真实 BV 号（走 API 兜底）');
  const info = await client.callTool({ name: 'bili_video_info', arguments: { url: 'https://www.bilibili.com/video/BV1GJ411x7h7' } });
  const infoText = textOf(info);
  ok('拿到元信息', !info.isError && /title/.test(infoText), infoText.slice(0, 90).replace(/\n/g, ' '));

  console.log('\n[6] media_frames：strategy 参数');
  const recent = await client.callTool({ name: 'media_frames', arguments: { input: mp4, frames: 5, strategy: 'recent' } });
  ok('recent 策略可用', !recent.isError, textOf(recent).split('\n').find((l) => l.startsWith('取帧')) || '');
} catch (error) {
  console.error('❌ 协议层失败：', error?.message ?? error);
  fail += 1;
} finally {
  try { await client.close(); } catch {}
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
