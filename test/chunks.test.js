import test from 'node:test';
import assert from 'node:assert/strict';
import { makePipeline } from '../src/pipeline.js';

const pipe = makePipeline();

test('planChunks：时长切成等长区间，首尾对齐', () => {
  const r = pipe.planChunks(40, 3);
  assert.equal(r.length, 3);
  assert.equal(r[0].start, 0);
  assert.equal(r[2].end, 40);
  assert.ok(Math.abs(r[1].start - 13.33) < 0.02, `第二段起点 ${r[1].start}`);
  // 区间连续：上一段 end === 下一段 start
  for (let i = 1; i < r.length; i += 1) assert.equal(r[i].start, r[i - 1].end);
});

test('planChunks：太短的视频自动减段数', () => {
  assert.equal(pipe.planChunks(2, 6).length, 1);
  assert.equal(pipe.planChunks(3.2, 6).length, 2);
  assert.equal(pipe.planChunks(0, 4).length, 1);
});

test('fillTimes：在区间内补齐到 want 个、不越界', () => {
  const ts = pipe.fillTimes([], 3, 10, 20);
  assert.equal(ts.length, 3);
  for (const t of ts) assert.ok(t >= 10 && t <= 20, `越界：${t}`);
  assert.deepEqual([...ts].sort((a, b) => a - b), ts, '应已排序');
});

test('fillTimes：已有的时间点保留，不够再补', () => {
  const ts = pipe.fillTimes([12], 3, 10, 20);
  assert.equal(ts.length, 3);
  assert.ok(ts.includes(12));
  // 超出区间的候选被丢掉
  const dirty = pipe.fillTimes([5, 12, 99], 3, 10, 20);
  assert.equal(dirty.length, 3);
  assert.ok(!dirty.includes(5) && !dirty.includes(99));
});
