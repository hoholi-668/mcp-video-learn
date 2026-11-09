// 固定容量队列（FIFO）+ 准入策略：决定「哪些帧值得进九宫格」。
//
// 为什么不是简单均匀抽帧：
//   一段 5 分钟的视频里可能 4 分钟是静止画面。均匀抽 9 帧会浪费 7 格在重复画面上。
//   这里只在「画面发生明显变化」时把帧放进队列，队列满了就淘汰最旧的（先进先出）。
//
// 两种取用方式：
//   · recent  —— 队列的最终快照 = 最近 N 个变化瞬间（直播/长视频结尾最有用）
//   · overview —— 把所有变化点均匀摊开取 N 个（理解整段内容用）
//
// 队列本身是纯数据结构，方便单测；抽帧在 index.js 里做。

/**
 * 固定容量环形队列。
 * push 时若未满则入队；若已满，淘汰队首（最旧）再入队 —— 这就是 FIFO。
 */
export class FrameQueue {
  constructor(capacity) {
    this.capacity = Math.max(1, Math.round(Number(capacity) || 9));
    this.items = [];
  }

  get size() { return this.items.length; }
  get full() { return this.items.length >= this.capacity; }

  push(item) {
    if (!item) return { accepted: false, evicted: null };
    let evicted = null;
    if (this.full) evicted = this.items.shift();
    this.items.push(item);
    return { accepted: true, evicted };
  }

  /** 当前快照（副本，别让调用方改到内部数组）。 */
  snapshot() { return [...this.items]; }

  clear() { this.items = []; }
}

/**
 * 队内变化分的中位数（偶数个取中间两个的平均）。
 * 相对门槛用它：不同视频的亮度/色差基线差别很大，绝对阈值没法通用。
 */
export function medianScore(queue) {
  const arr = queue.snapshot().map((x) => Number(x?.score) || 0).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/**
 * 准入判断：队列没满时先填满；满了之后只收「不弱于队内中位数」的变化点。
 *
 * 为什么用相对阈值：sceneCandidates 的分数是 0~255 的 Y/U/V 差分均值，
 * 不同素材（夜景/雪景/幻灯片）基线差很多，写死一个绝对阈值要么全收要么全拒。
 * 取中位数 = 每次替换都要求「比队里一半以上的帧变化更明显」。
 *
 * @param {number} [opts.minScore] 可选的绝对下限（默认 0，不启用）
 */
export function shouldAdmit(queue, sceneScore, { minScore = 0 } = {}) {
  if (!queue.full) return true;
  const score = Number(sceneScore) || 0;
  const floor = Number(minScore) || 0;
  if (score < floor) return false;
  return score >= medianScore(queue);
}

/**
 * overview：把候选时间点均匀摊开取 n 个。
 * 这是「理解整段」用的取样方式——先按变化检测拿到所有候选，
 * 再从头到尾等距挑，避免只看结尾。
 */
export function spreadPick(timestamps, n) {
  const list = Array.isArray(timestamps) ? timestamps.filter((t) => Number.isFinite(Number(t))) : [];
  const want = Math.max(1, Math.round(Number(n) || 1));
  if (!list.length) return [];
  if (list.length <= want) return [...list];
  const step = (list.length - 1) / (want - 1 || 1);
  const out = [];
  for (let i = 0; i < want; i += 1) {
    const idx = want === 1 ? 0 : Math.round(i * step);
    out.push(list[Math.min(list.length - 1, idx)]);
  }
  // 去重（极端情况下四舍五入会撞同一个下标）
  return [...new Set(out)];
}

/**
 * 把候选点喂进 FIFO 队列，返回队列最终快照。
 * recent 策略：就是队列最后 N 个（最旧被挤掉）。
 */
export function feedQueue(candidates, capacity, { minScore = 0.25 } = {}) {
  const q = new FrameQueue(capacity);
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const t = Number(c?.t);
    if (!Number.isFinite(t)) continue;
    if (!shouldAdmit(q, c?.score, { minScore })) continue;
    q.push({ t, score: Number(c?.score) || 0 });
  }
  return q.snapshot();
}

/**
 * 根据策略选最终帧时间点。
 * @param {Array<{t:number,score:number}>} candidates 场景变化候选（按时间升序）
 * @param {number} n 需要几帧
 * @param {'overview'|'recent'} strategy
 */
export function pickTimestamps(candidates, n, strategy = 'overview', { minScore = 0 } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => Number.isFinite(Number(c?.t)));
  if (!list.length) return [];
  if (strategy === 'recent') {
    return feedQueue(list, n, { minScore }).map((x) => x.t);
  }
  // overview：用场景变化点做候选，但均匀摊开覆盖全程
  return spreadPick(list.map((c) => c.t), n);
}
