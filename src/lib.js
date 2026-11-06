// 纯函数：不依赖外部进程，方便单测。
// 从 mcp-video-learn.js 抽出，行为与原实现一致。

/** 只接受 B 站链接，避免被当成任意下载器。 */
export function normalizeBiliUrl(raw) {
  const url = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (!/(^|\.)bilibili\.com$/.test(host) && !/(^|\.)b23\.tv$/.test(host)) return null;
  return url;
}

/** 把秒数变成「1分23秒」这种中文可读形式。 */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`;
}

/**
 * VTT/SRT 转纯文本：去掉时间轴与标签，按行合并、去重连续重复。
 * 字幕文件里同一句话常被切成多行重复出现，这里压成一段。
 */
export function subtitlesToText(raw) {
  const lines = String(raw ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^WEBVTT/.test(line) && !/^\d+$/.test(line) && !/-->/.test(line))
    .map((line) => line.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (out[out.length - 1] !== line) out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 根据帧数算网格：>=9 帧用 3 列，否则 2 列。
 * 返回值用于 ffmpeg 的 tile 滤镜。
 */
export function gridFor(frames) {
  const want = Math.max(1, Math.min(12, Math.round(Number(frames) || 9)));
  const cols = want >= 9 ? 3 : 2;
  const rows = Math.ceil(want / cols);
  return { want, cols, rows };
}

/** 在下载目录里挑最大的视频文件（yt-dlp 合并后会给出 mp4/mkv/webm）。 */
export function pickVideoFile(names) {
  const candidates = (Array.isArray(names) ? names : [])
    .filter((name) => /\.(mp4|mkv|webm|flv|mov)$/i.test(String(name)));
  return candidates.length ? candidates[0] : null;
}
