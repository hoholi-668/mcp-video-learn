import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePipeline } from '../src/pipeline.js';

const pipe = makePipeline();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'));
const file = path.join(dir, 'c.mp4');
const colors = ['red', 'green', 'blue', 'yellow'];
const inputs = colors.flatMap((c) => ['-f', 'lavfi', '-i', `color=${c}:size=320x240:rate=10:duration=1`]);
await pipe.run(pipe.ffmpeg, ['-v', 'error', '-y', ...inputs,
  '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', file]);

console.log('文件:', file, fs.statSync(file).size, 'bytes');

// 原样跑一遍滤镜，看输出到底长什么样
const raw = await pipe.run(pipe.ffmpeg, ['-v', 'info', '-i', file,
  '-vf', 'tblend=all_mode=difference,signalstats,metadata=print:file=-', '-an', '-f', 'null', '-']);
console.log('stdout 长度:', raw.stdout.length, '| stderr 长度:', raw.stderr.length);
console.log('stdout 前 300:', JSON.stringify(raw.stdout.slice(0, 300)));

for (const th of [20, 10, 5, 2]) {
  const c = await pipe.sceneCandidates(file, { minScore: th });
  console.log(`阈值 ${th}: ${c.length} 个点`, c.map((x) => `${x.t.toFixed(1)}(s${x.score.toFixed(0)})`).join(', '));
}
const built = await pipe.buildVideoGrid({ file, want: 5, strategy: 'recent', dir });
console.log('构建:', built.ok, 'mode=', built.mode, '帧=', (built.timestamps || []).map((t) => t.toFixed(1)).join(','));
