import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSharp } from '../src/webp-sharp.js';

// 生成一张真正的动图 WebP 供测试用：每帧一种颜色 + 一个移动方块（有内容，不是纯色）
const outDir = process.argv[2] || os.tmpdir();
const sharp = await loadSharp();
if (!sharp) { console.error('需要 sharp（设 SHARP_MODULE）'); process.exit(1); }

const frames = [];
for (let i = 0; i < 8; i += 1) {
  const svg = `<svg width="160" height="120" xmlns="http://www.w3.org/2000/svg">
    <rect width="160" height="120" fill="#${(i * 32).toString(16).padStart(2, '0')}4060"/>
    <rect x="${10 + i * 15}" y="${20 + i * 8}" width="40" height="40" fill="#ffffff"/>
  </svg>`;
  frames.push(await sharp(Buffer.from(svg)).png().toBuffer());
}
const out = path.join(outDir, 'anim-real.webp');
await sharp(frames, { animated: true }).webp({ delay: [100], loop: 0 }).toFile(out);
console.log('生成:', out, fs.statSync(out).size, 'bytes');
