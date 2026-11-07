// 演示用：一次性打满 video-learn 的六种输入，打印结果 + 产出图路径。
// 用法（服务器上）：
//   cd /opt/mcp-plugins/mcp-video-learn && node demo-video.mjs
//
// 每个用例都会真实调用线上那份 src/index.js（MCP stdio），不是本地函数。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = '/opt/mcp-plugins/mcp-video-learn/src/index.js';
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-'));
const env = {
  ...process.env,
  VIDEO_FFMPEG: '/usr/bin/ffmpeg',
  VIDEO_YTDLP: '/usr/local/bin/yt-dlp',
  BILI_COOKIES: '/opt/qq-bridge/bili-cookies.txt',
  VIDEO_COOKIES: '/opt/qq-bridge/bili-cookies.txt',
  VIDEO_ALLOW_ROOTS: '/opt/qq-bridge:/tmp:/root',
  VIDEO_AUDIT: '/root/.dsh/video-learn-audit.jsonl',
  SHARP_MODULE: '/usr/local/lib/node/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp'
};

const cases = [
  {
    id: 'C1 本地 GIF（动图表情）',
    tool: 'media_frames',
    args: { input: '/tmp/matrix-live/anim.gif', frames: 6 },
    expect: (t) => /来源：local/.test(t) && /动图|GIF/.test(t)
  },
  {
    id: 'C2 本地短视频（九宫格）',
    tool: 'media_frames',
    args: { input: '/tmp/matrix-live/short.mp4', frames: 9 },
    expect: (t) => /场景变化|均匀采样/.test(t)
  },
  {
    id: 'C3 视频结尾（recent 策略）',
    tool: 'media_frames',
    args: { input: '/tmp/matrix-live/long.mp4', frames: 9, strategy: 'recent' },
    expect: (t) => /recent|最近/.test(t)
  },
  {
    id: 'C4 静态图',
    tool: 'media_frames',
    args: { input: '/tmp/matrix-live/still.png' },
    expect: (t) => /来源：local/.test(t)
  },
  {
    id: 'C5 媒体直链（真动图 WebP，需要 sharp）',
    tool: 'media_frames',
    args: { input: 'https://www.gstatic.com/webp/animated/1.webp', frames: 6 },
    expect: (t) => /webp|sharp|直链|下载/i.test(t)
  },
  {
    id: 'C6 B 站元信息（API 通道）',
    tool: 'bili_video_info',
    args: { url: 'https://www.bilibili.com/video/BV1GJ411x7h7' },
    expect: (t) => /"title"/.test(t)
  }
];

const c = new Client({ name: 'demo', version: '0' });
await c.connect(new StdioClientTransport({ command: '/usr/local/bin/node', args: [SERVER], env }));

const rows = [];
for (const k of cases) {
  const t0 = Date.now();
  let ok = false;
  let detail = '';
  let imgPath = '';
  try {
    const r = await c.callTool({ name: k.tool, arguments: k.args });
    const text = (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    const img = (r.content || []).find((x) => x.type === 'image');
    if (img?.data) {
      imgPath = path.join(OUT, `${k.id.split(' ')[0]}.jpg`);
      fs.writeFileSync(imgPath, Buffer.from(img.data, 'base64'));
    }
    ok = !r.isError && k.expect(text);
    detail = text.replace(/\s+/g, ' ').slice(0, 110);
  } catch (e) {
    detail = String(e?.message ?? e);
  }
  rows.push({ id: k.id, ok, ms: Date.now() - t0, detail, imgPath });
  console.log(`${ok ? '✅' : '❌'} ${k.id}  (${Date.now() - t0}ms)`);
  console.log(`   ${detail}`);
  if (imgPath) console.log(`   图: ${imgPath}`);
}

await c.close();
const pass = rows.filter((r) => r.ok).length;
console.log(`\n结果：${pass}/${rows.length} 通过`);
console.log(`产出目录：${OUT}`);
process.exit(pass === rows.length ? 0 : 1);
