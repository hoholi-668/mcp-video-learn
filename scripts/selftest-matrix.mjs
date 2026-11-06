#!/usr/bin/env node
// 全场景自测矩阵：把「能想到的情况」都跑一遍。
//
// 覆盖：格式（mp4/gif/webp/png）、尺寸（横屏/竖屏/极小）、时长（1s/长视频）、
//      参数（frames 1~12、tileWidth 64~640、两种策略）、
//      坏输入（假 mp4、损坏文件、不存在路径、白名单外路径、非媒体直链）、
//      退化路径（纯色无场景变化 → uniform）。
//
// 用法：node scripts/selftest-matrix.mjs [outputDir]
// 退出码非 0 表示有失败项。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePipeline } from '../src/pipeline.js';
import { isUnderRoots, isDirectMediaUrl, describeProbe, guessKind } from '../src/media.js';

const outDir = process.argv[2] || path.join(os.tmpdir(), 'video-matrix');
fs.mkdirSync(outDir, { recursive: true });
const pipe = makePipeline();

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); return true; }
  fail += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

// ── 造素材 ───────────────────────────────────────────────────────────────
console.log('\n[素材] 生成测试文件 …');
const { ffmpeg } = pipe;

async function ff(args, timeout = 90_000) { return pipe.run(ffmpeg, ['-v', 'error', '-y', ...args], timeout); }

async function colorsVideo(file, secondsPerColor, colors, { size = '320x240', rate = 10, vertical = false } = {}) {
  const dims = vertical ? '240x320' : size;
  const inputs = [];
  for (const c of colors) inputs.push('-f', 'lavfi', '-i', `color=${c}:size=${dims}:rate=${rate}:duration=${secondsPerColor}`);
  const concat = colors.map((_, i) => `[${i}:v]`).join('') + `concat=n=${colors.length}:v=1:a=0[v]`;
  return ff([...inputs, '-filter_complex', concat, '-map', '[v]', '-pix_fmt', 'yuv420p', file]);
}

const fixtures = {
  short: path.join(outDir, 'short.mp4'),      // 6s，3 段颜色
  long: path.join(outDir, 'long.mp4'),        // 40s，20 段
  flat: path.join(outDir, 'flat.mp4'),        // 6s 纯色
  tiny: path.join(outDir, 'tiny.mp4'),        // 1s
  vertical: path.join(outDir, 'vertical.mp4'),
  gif: path.join(outDir, 'anim.gif'),
  webp: path.join(outDir, 'anim.webp'),
  png: path.join(outDir, 'still.png'),
  fakeMp4: path.join(outDir, 'fake.mp4'),
  corrupt: path.join(outDir, 'corrupt.mp4')
};

await colorsVideo(fixtures.short, 2, ['red', 'green', 'blue']);
await colorsVideo(fixtures.long, 2, ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'black', 'orange', 'purple',
  'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'black', 'orange', 'purple']);
await ff(['-f', 'lavfi', '-i', 'color=navy:size=320x240:rate=10:duration=6', '-pix_fmt', 'yuv420p', fixtures.flat]);
await ff(['-f', 'lavfi', '-i', 'color=teal:size=320x240:rate=10:duration=1', '-pix_fmt', 'yuv420p', fixtures.tiny]);
await colorsVideo(fixtures.vertical, 2, ['red', 'green', 'blue'], { vertical: true });
await ff(['-i', fixtures.short, '-t', '4', '-vf', 'fps=8,scale=160:-1', fixtures.gif]);
await ff(['-i', fixtures.short, '-t', '4', '-vf', 'fps=8,scale=160:-1', '-c:v', 'libwebp_anim', fixtures.webp]);
await ff(['-f', 'lavfi', '-i', 'color=white:size=320x240:duration=1', '-frames:v', '1', fixtures.png]);
fs.writeFileSync(fixtures.fakeMp4, 'this is not a video at all\n'.repeat(50), 'utf8');
fs.writeFileSync(fixtures.corrupt, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)));
for (const [k, file] of Object.entries(fixtures)) {
  ok(`素材 ${k}`, fs.existsSync(file) && fs.statSync(file).size > 0, `${Math.round(fs.statSync(file).size / 1024)} KB`);
}

// ── 网格尺寸校验：宽 ≈ cols * tileWidth（含 padding） ─────────────────────
async function imageWidth(file) {
  const res = await pipe.run(pipe.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', file]);
  try { return Number(JSON.parse(res.stdout).streams[0].width) || 0; } catch { return 0; }
}

async function runGrid(label, file, { want, strategy = 'overview', tileWidth = 240, expectMode } = {}) {
  const dir = fs.mkdtempSync(path.join(outDir, 'g-'));
  const built = await pipe.buildVideoGrid({ file, want, strategy, tileWidth, dir });
  const kb = built.ok ? Math.round(fs.statSync(built.outJpg).size / 1024) : 0;
  ok(`${label} 出图`, built.ok, built.ok ? `${kb}KB mode=${built.mode}` : built.error);
  if (built.ok && expectMode) ok(`${label} 模式=${expectMode}`, built.mode === expectMode, `实际 ${built.mode}`);
  if (built.ok && tileWidth) {
    const w = await imageWidth(built.outJpg);
    const cols = want >= 5 ? 3 : 2;
    const expect = cols * tileWidth;
    ok(`${label} 网格宽度`, Math.abs(w - expect) <= cols * 8, `实际 ${w}px，预期约 ${expect}px`);
  }
  return built;
}

// ── 1) 正常视频矩阵 ─────────────────────────────────────────────────────
console.log('\n[1] 正常视频 …');
await runGrid('短横屏 9帧 overview', fixtures.short, { want: 9, expectMode: 'scene' });
await runGrid('短横屏 9帧 recent', fixtures.short, { want: 9, strategy: 'recent', expectMode: 'scene' });
await runGrid('40s 长视频 9帧', fixtures.long, { want: 9, expectMode: 'scene' });
await runGrid('竖屏 9帧', fixtures.vertical, { want: 9, expectMode: 'scene' });
await runGrid('1 秒短视频 9帧', fixtures.tiny, { want: 9, expectMode: 'uniform' });
await runGrid('纯色视频 9帧', fixtures.flat, { want: 9, expectMode: 'uniform' });

// ── 2) 参数矩阵 ─────────────────────────────────────────────────────────
console.log('\n[2] 参数边界 …');
for (const want of [1, 4, 6, 9, 12]) {
  await runGrid(`frames=${want}`, fixtures.short, { want, expectMode: want >= 2 ? 'scene' : 'uniform' });
}
await runGrid('tileWidth=64', fixtures.short, { want: 9, tileWidth: 64, expectMode: 'scene' });
await runGrid('tileWidth=640', fixtures.short, { want: 9, tileWidth: 640, expectMode: 'scene' });

// ── 3) 动图 / 静态图 ────────────────────────────────────────────────────
console.log('\n[3] 动图与静态图 …');
{
  const probe = await pipe.probeMedia(fixtures.gif);
  const meta = describeProbe(probe);
  ok('GIF 帧数识别', meta.frames > 1 || meta.animated, `frames=${meta.frames} dur=${meta.durationSec}`);
  ok('GIF 类型判定', guessKind(fixtures.gif) === 'image');
}
await runGrid('GIF 6帧', fixtures.gif, { want: 6, expectMode: 'uniform' });
{
  // 坏 WebP：libvips 会把它解成空白页而不报错，插件必须识破并拒绝（防假成功）
  const built = await pipe.buildVideoGrid({ file: fixtures.webp, want: 6, dir: fs.mkdtempSync(path.join(outDir, 'g-')) });
  ok('坏 WebP 被识破（不假装成功）', !built.ok && /空白|损坏|sharp|ffmpeg/.test(built.error || ''), (built.error || '').slice(0, 70));
}
{
  // 真动图 WebP：需要外部样例（ANIM_WEBP 指向一个真·动图 WebP）
  const anim = process.env.ANIM_WEBP;
  if (!anim || !fs.existsSync(anim)) {
    console.log('  (跳过真动图 WebP：未提供 ANIM_WEBP)');
  } else {
    const built = await pipe.buildVideoGrid({ file: anim, want: 6, dir: fs.mkdtempSync(path.join(outDir, 'g-')) });
    if (process.env.SHARP_MODULE) {
      ok('真动图 WebP 经 sharp 解码', built.ok && built.mode === 'webp-sharp', built.ok ? built.note : built.error?.slice(0, 60));
    } else {
      ok('无 sharp 时真动图给出明确提示', !built.ok && /sharp|ffmpeg/.test(built.error || ''), (built.error || '').slice(0, 60));
    }
  }
}
{
  // 静态 WebP 必须能看
  const stillWebp = path.join(outDir, 'still.webp');
  await ff(['-i', fixtures.png, '-c:v', 'libwebp', stillWebp]);
  const built = await pipe.buildVideoGrid({ file: stillWebp, want: 1, dir: fs.mkdtempSync(path.join(outDir, 'g-')) });
  ok('静态 WebP 可出图', built.ok, built.ok ? 'ok' : built.error?.slice(0, 60));
}
await runGrid('静态 PNG', fixtures.png, { want: 6, expectMode: 'uniform' });

// ── 4) 坏输入 ───────────────────────────────────────────────────────────
console.log('\n[4] 坏输入 …');
{
  const built = await pipe.buildVideoGrid({ file: fixtures.fakeMp4, want: 9, dir: fs.mkdtempSync(path.join(outDir, 'g-')) });
  ok('假 mp4 应失败而不是出图', !built.ok, built.error?.slice(0, 60) || 'ok=true');
}
{
  const built = await pipe.buildVideoGrid({ file: fixtures.corrupt, want: 9, dir: fs.mkdtempSync(path.join(outDir, 'g-')) });
  ok('损坏文件应失败', !built.ok);
}
{
  const built = await pipe.buildVideoGrid({ file: path.join(outDir, 'nope.mp4'), want: 9, dir: fs.mkdtempSync(path.join(outDir, 'g-')) });
  ok('不存在的文件应失败', !built.ok);
}

// ── 5) 安全边界 ─────────────────────────────────────────────────────────
console.log('\n[5] 安全边界 …');
ok('白名单外路径被拒', isUnderRoots('/etc/passwd', [outDir]) === false);
ok('白名单内路径放行', isUnderRoots(path.join(outDir, 'short.mp4'), [outDir]) === true);
ok('兄弟目录不算白名单内', isUnderRoots(`${outDir}-evil/x.mp4`, [outDir]) === false);
ok('非媒体直链被拒', isDirectMediaUrl('https://example.com/a.exe') === false);
ok('媒体直链放行', isDirectMediaUrl('https://example.com/a.gif') === true);
ok('ftp 协议被拒', isDirectMediaUrl('ftp://example.com/a.gif') === false);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('失败项：');
  for (const f of failures) console.error('  -', f);
}
process.exitCode = fail ? 1 : 0;



