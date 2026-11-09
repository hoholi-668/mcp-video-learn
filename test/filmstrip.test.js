import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameQueue, shouldAdmit, medianScore, spreadPick, feedQueue, pickTimestamps } from '../src/filmstrip.js';

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

test('准入：没满先填满，满了用「队内中位数」做相对门槛', () => {
  const q = new FrameQueue(2);
  assert.equal(shouldAdmit(q, 0), true);          // 空队列，再差的帧也收
  q.push({ t: 1, score: 20 });
  assert.equal(shouldAdmit(q, 0), true);          // 未满
  q.push({ t: 2, score: 40 });
  assert.equal(q.full, true);
  assert.equal(medianScore(q), 30);               // (20+40)/2
  assert.equal(shouldAdmit(q, 10), false);        // 比中位数弱 → 不收
  assert.equal(shouldAdmit(q, 30), true);         // 等于中位数 → 收（平手让新的进来）
  assert.equal(shouldAdmit(q, 90), true);         // 更强 → 收
});

test('相对门槛会随素材基线自适应', () => {
  // 高基线素材：中位数 120，弱变化 40 被拒
  const hi = new FrameQueue(3);
  [{ s: 100 }, { s: 120 }, { s: 140 }].forEach((x, i) => hi.push({ t: i, score: x.s }));
  assert.equal(shouldAdmit(hi, 40), false);
  // 低基线素材：中位数 8，同样的 40 就能进
  const lo = new FrameQueue(3);
  [{ s: 4 }, { s: 8 }, { s: 12 }].forEach((x, i) => lo.push({ t: i, score: x.s }));
  assert.equal(shouldAdmit(lo, 40), true);
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
