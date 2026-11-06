import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameQueue, shouldAdmit, spreadPick, feedQueue, pickTimestamps } from '../src/filmstrip.js';

test('队列满了就淘汰最旧的（FIFO）', () => {
  const q = new FrameQueue(3);
  q.push({ t: 1 }); q.push({ t: 2 }); q.push({ t: 3 });
  assert.equal(q.size, 3);
  assert.equal(q.full, true);
  const r = q.push({ t: 4 });
  assert.deepEqual(r.evicted, { t: 1 });
  assert.deepEqual(q.snapshot().map((x) => x.t), [2, 3, 4]);
  // 快照是副本
  q.snapshot().push({ t: 99 });
  assert.equal(q.size, 3);
});

test('准入：没满先填满，满了才看变化分', () => {
  const q = new FrameQueue(2);
  assert.equal(shouldAdmit(q, 0), true);       // 空队列，再差的帧也收
  q.push({ t: 1 });
  assert.equal(shouldAdmit(q, 0), true);       // 未满
  q.push({ t: 2 });
  assert.equal(q.full, true);
  assert.equal(shouldAdmit(q, 0.1), false);    // 满了且变化小 → 不收
  assert.equal(shouldAdmit(q, 0.9), true);     // 变化大 → 收
});

test('overview：均匀摊开、不偏向结尾', () => {
  const ts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const picked = spreadPick(ts, 3);
  assert.deepEqual(picked, [0, 5, 9]);
  // 只要 1 个时取开头
  assert.deepEqual(spreadPick(ts, 1), [0]);
  // 候选比需要少时全给
  assert.deepEqual(spreadPick([1, 2], 5), [1, 2]);
});

test('recent：队列快照是最近 N 个变化点（FIFO 语义）', () => {
  const candidates = [0, 1, 2, 3, 4, 5].map((t) => ({ t, score: 0.9 }));
  const recent = pickTimestamps(candidates, 3, 'recent');
  assert.deepEqual(recent, [3, 4, 5]);
  const overview = pickTimestamps(candidates, 3, 'overview');
  assert.deepEqual(overview, [0, 3, 5]);
});

test('变化小的帧进不了已满的队列', () => {
  const candidates = [
    { t: 0, score: 0.9 }, { t: 1, score: 0.9 },
    { t: 2, score: 0.05 }, { t: 3, score: 0.9 }
  ];
  const recent = feedQueue(candidates, 2, { minScore: 0.25 });
  // t=2 变化太小被拒，所以最终是 [0,3]？队列：0,1 满 -> 2 拒 -> 3 入队淘汰 0 => [1,3]
  assert.deepEqual(recent.map((x) => x.t), [1, 3]);
});

test('非法候选被忽略', () => {
  assert.deepEqual(pickTimestamps([{ t: 'x' }, { t: NaN }], 3, 'overview'), []);
  assert.deepEqual(pickTimestamps([], 3, 'recent'), []);
  assert.deepEqual(feedQueue([null, undefined], 3), []);
});
