// 媒体 → 模型可读的“帧网格”。
// 纯函数为主，方便单测；真正抽帧在 index.js 里调 ffmpeg/ffprobe。

import path from 'node:path';

/** 支持的扩展名 → 是否视频（视频抽帧密度低一点）。 */
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.flv', '.mov', '.avi', '.m4v']);
const ANIM_EXT = new Set(['.gif', '.webp', '.apng']);

export function guessKind(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (ANIM_EXT.has(ext)) return 'image';
  if (['.png', '.jpg', '.jpeg', '.bmp'].includes(ext)) return 'still';
  return 'unknown';
}

/**
 * 动图和视频用不同的默认帧数：
 *   - 动图：6 帧（3×2），正好覆盖一个短循环，帧太大反而看不清
 *   - 视频：9 帧（3×3），需要覆盖更长时间
 * 用户显式传帧数时以用户为准（夹在 1~12）。
 */
export function pickFrames(kind, requested) {
  const n = Number(requested);
  if (Number.isFinite(n) && n >= 1) return Math.max(1, Math.min(12, Math.round(n)));
  return kind === 'video' ? 9 : 6;
}

/** 帧数 → 网格列数。6 帧用 3 列（3×2），9 帧用 3 列（3×3）。 */
export function gridForFrames(frames) {
  const want = Math.max(1, Math.min(12, Math.round(Number(frames) || 6)));
  const cols = want >= 5 ? 3 : 2;
  return { want, cols, rows: Math.ceil(want / cols) };
}

/** ffmpeg 的 tile 滤镜字符串。 */
export function tileFilter({ cols, rows }, { tileWidth = 240, padding = 4, margin = 4 } = {}) {
  const w = Math.max(64, Math.min(640, Math.round(Number(tileWidth) || 240)));
  return `scale=${w}:-1:flags=lanczos,tile=${cols}x${rows}:padding=${padding}:margin=${margin}:color=white`;
}

/**
 * 本地文件必须落在允许的根目录里，防止这个 MCP 变成任意文件读取器。
 * roots 用 path.delimiter 分隔（Windows 是 `;`，POSIX 是 `:`）。
 */
export function isUnderRoots(target, roots) {
  const abs = path.resolve(String(target || ''));
  for (const root of roots) {
    if (!root) continue;
    const base = path.resolve(String(root));
    const rel = path.relative(base, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

/** 直链只允许这些媒体扩展名（不做通用下载器）。 */
export function isDirectMediaUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const ext = path.extname(url.pathname).toLowerCase();
  return VIDEO_EXT.has(ext) || ANIM_EXT.has(ext) || ['.png', '.jpg', '.jpeg'].includes(ext);
}

/** 把 ffprobe 的 JSON 归一成我们要的元信息。 */
export function describeProbe(probe) {
  const stream = (probe?.streams || []).find((s) => s.codec_type === 'video') || {};
  const fmt = probe?.format || {};
  const frames = Number(stream.nb_frames) || 0;
  const durationSec = Number(fmt.duration) || Number(stream.duration) || 0;
  const still = frames === 1 && durationSec === 0;
  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    frames,
    durationSec: Math.round(durationSec * 10) / 10,
    animated: frames > 1 || durationSec > 0.2,
    still,
    format: String(fmt.format_name || '').split(',')[0] || ''
  };
}
