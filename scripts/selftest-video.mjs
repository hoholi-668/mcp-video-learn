#!/usr/bin/env node
// 真实视频自测：用 ffmpeg 生成测试视频，走完整管线（场景检测 → FIFO 队列 → 网格），检查产出。
// 覆盖三条路径：
//   1) 场景变化多 → 必须走 scene 模式，九宫格 9 帧
//   2) overview vs recent → 时间点必须不同（FIFO 语义）
//   3) 无变化视频 → 必须退回 uniform 模式（不能报错）
//
// 用法：node scripts/selftest-video.mjs [outputDir]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePipeline } from '../src/pipeline.js';

const outDir = process.argv[2] || path.join(os.tmpdir(), 'video-selftest');
fs.mkdirSync(outDir, { recursive: true });
const pipe = makePipeline();

let failed = 0;
function check(cond, msg, detail = '') {
  if (cond) { console.log(`    ✅ ${msg}${detail ? ` — ${detail}` : ''}`); return true; }
  console.error(`    ❌ ${msg}${detail ? ` — ${detail}` : ''}`);
  failed += 1;
  return false;
}

// ── 1) 造一段「每秒换一个颜色」的视频（20 段，场景变化充足）───────────────
console.log('[1/4] 生成测试视频（20 段颜色，每秒一换）…');
const cuts = path.join(outDir, 'cuts.mp4');
const colors = ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'black', 'orange', 'purple'];
const inputs = [];
for (let i = 0; i < 20; i += 1) {
  inputs.push('-f', 'lavfi', '-i', `color=${colors[i % colors.length]}:size=320x240:rate=10:duration=1`);
}
const concat = Array.from({ length: 20 }, (_, i) => `[${i}:v]`).join('') + 'concat=n=20:v=1:a=0[v]';
const gen = await pipe.run(pipe.ffmpeg, ['-v', 'error', '-y', ...inputs, '-filter_complex', concat, '-map', '[v]', '-pix_fmt', 'yuv420p', cuts], 60_000);
check(gen.ok && fs.existsSync(cuts), '测试视频已生成', `${Math.round(fs.statSync(cuts).size / 1024)} KB`);
if (!fs.existsSync(cuts)) { console.error('无法继续'); process.exit(1); }

// ── 2) 场景检测 ─────────────────────────────────────────────────────────
console.log('[2/4] 场景变化检测 …');
const cands = await pipe.sceneCandidates(cuts);
check(cands.length >= 8, '检测到足够的变化点', `${cands.length} 个`);

// ── 3) 两种策略：必须走 scene，且时间点不同 ──────────────────────────────
console.log('[3/4] overview / recent …');
const results = {};
for (const strategy of ['overview', 'recent']) {
  const dir = fs.mkdtempSync(path.join(outDir, `grid-${strategy}-`));
  const built = await pipe.buildVideoGrid({ file: cuts, want: 9, strategy, dir });
  results[strategy] = built;
  const kb = built.ok ? Math.round(fs.statSync(built.outJpg).size / 1024) : 0;
  check(built.ok, `${strategy} 产出网格`, `${kb} KB`);
  check(built.mode === 'scene', `${strategy} 走的是场景路径`, `mode=${built.mode}`);
  check((built.timestamps || []).length === 9, `${strategy} 取到 9 帧`, (built.timestamps || []).map((t) => t.toFixed(1)).join(', '));
}

const ov = results.overview?.timestamps || [];
const rc = results.recent?.timestamps || [];
check(ov.length && rc.length && ov[0] !== rc[0], 'overview 与 recent 时间点不同（FIFO 语义生效）',
  `overview 起于 ${ov[0]?.toFixed(1)}s，recent 起于 ${rc[0]?.toFixed(1)}s`);
check(rc.length > 0 && rc[rc.length - 1] >= 15, 'recent 落在视频后段', `末尾 ${rc[rc.length - 1]?.toFixed(1)}s`);

// ── 4) 无变化视频必须退回 uniform（不能报错）──────────────────────────────
console.log('[4/4] 纯色视频（无场景变化）…');
const flat = path.join(outDir, 'flat.mp4');
const genFlat = await pipe.run(pipe.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=navy:size=320x240:rate=10:duration=6', '-pix_fmt', 'yuv420p', flat], 30_000);
if (genFlat.ok) {
  const dir = fs.mkdtempSync(path.join(outDir, 'grid-flat-'));
  const built = await pipe.buildVideoGrid({ file: flat, want: 9, strategy: 'overview', dir });
  check(built.ok, '无变化视频仍能出图');
  check(built.mode === 'uniform', '退回到均匀采样', `mode=${built.mode}`);
} else {
  console.log('    (跳过)');
}

console.log(failed ? `\n❌ 自测失败（${failed} 项）` : '\n✅ 自测通过');
process.exitCode = failed ? 1 : 0;
