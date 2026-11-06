// B 站官方 API 通道：不碰网页，机房 IP 也能用。
//
// 背景：yt-dlp 要抓 www.bilibili.com/video/...，而机房/云服务器 IP 会被 412 拦
// （cookie 救不了，因为拦的是网页请求）。官方 API 仍然可用，只要：
//   1) 带 buvid3（没有就向 /x/frontend/finger/spi 申请）
//   2) playurl 要 wbi 签名（w_rid = md5(query + mixin)）
//
// 这条路径是从同项目的 mcp-bili 移植过来的，逻辑一致。

import fs from 'node:fs';
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

// wbi 混淆表（B 站前端固定常量）
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

/** 读 Netscape 格式的 cookies.txt；文件不存在返回空表。 */
export function loadCookieMap(file) {
  const map = {};
  if (!file) return map;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (f.length >= 7) map[f[5]] = f[6];
    }
  } catch { /* 没文件也能走部分接口 */ }
  return map;
}

/** 从 "a=b; c=d" 形式的字符串读 cookie。 */
export function parseCookieHeader(str) {
  const map = {};
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && v) map[k] = v;
  }
  return map;
}

export function makeBiliApi({ cookiesFile = '', cookieHeader = '', maxBytes = 80 * 1024 * 1024 } = {}) {
  const cookieMap = { ...loadCookieMap(cookiesFile), ...parseCookieHeader(cookieHeader) };
  const header = () => Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');

  async function api(url, params) {
    const u = new URL(url);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    const r = await fetch(u, {
      headers: { 'user-agent': UA, referer: REFERER, cookie: header(), accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { throw new Error(`接口返回非 JSON（HTTP ${r.status}），可能被风控`); }
  }

  /** 没有 buvid3 就申请一个（不依赖登录态）。 */
  async function ensureBuvid() {
    if (cookieMap.buvid3) return;
    try {
      const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) });
      const j = await r.json();
      if (j?.data?.b_3) {
        cookieMap.buvid3 = j.data.b_3;
        if (j.data.b_4) cookieMap.buvid4 = j.data.b_4;
      }
    } catch { /* 忽略：后面请求可能仍成功 */ }
  }

  let wbiCache = null;
  async function wbiKeys() {
    if (wbiCache && Date.now() - wbiCache.at < 3_600_000) return wbiCache;
    const nav = await api('https://api.bilibili.com/x/web-interface/nav');
    const info = nav?.data?.wbi_img;
    if (!info) throw new Error('拿不到 wbi 签名材料（nav 接口异常）');
    const key = (u) => String(u || '').split('/').pop().split('.')[0];
    const raw = key(info.img_url) + key(info.sub_url);
    const mixin = MIXIN.map((i) => raw[i]).filter(Boolean).join('').slice(0, 32);
    wbiCache = { at: Date.now(), mixin };
    return wbiCache;
  }

  async function sign(params) {
    const { mixin } = await wbiKeys();
    const all = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(all).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    all.w_rid = crypto.createHash('md5').update(query + mixin).digest('hex');
    return all;
  }

  function parseBvid(input) {
    const s = String(input ?? '').trim();
    if (s.includes('b23.tv')) return { short: s };
    const m = s.match(/BV[0-9A-Za-z]{10}/);
    return m ? { bvid: m[0] } : null;
  }

  async function resolveShort(shortUrl) {
    const r = await fetch(shortUrl, { headers: { 'user-agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const loc = r.headers.get('location') || '';
    const m = loc.match(/BV[0-9A-Za-z]{10}/);
    if (m) return m[0];
    const body = await r.text().catch(() => '');
    const m2 = body.match(/BV[0-9A-Za-z]{10}/);
    return m2 ? m2[0] : null;
  }

  async function meta(rawUrl) {
    await ensureBuvid();
    const parsed = parseBvid(rawUrl);
    if (!parsed) throw new Error('只支持 bilibili.com / b23.tv 链接');
    const bvid = parsed.bvid || (await resolveShort(parsed.short));
    if (!bvid) throw new Error('无法从链接解析出 BV 号');
    const view = await api('https://api.bilibili.com/x/web-interface/view', { bvid });
    if (view?.code !== 0) throw new Error(`view 接口失败：${view?.code} ${view?.message ?? ''}`);
    const d = view.data;
    return {
      bvid,
      cid: d.pages?.[0]?.cid ?? d.cid,
      title: d.title,
      uploader: d.owner?.name || '',
      duration: Number(d.duration) || 0,
      desc: String(d.desc ?? '').slice(0, 400),
      views: d.stat?.view ?? null
    };
  }

  async function subtitles(m) {
    try {
      const p = await sign({ bvid: m.bvid, cid: m.cid });
      const r = await api('https://api.bilibili.com/x/player/wbi/v2', p);
      const list = r?.data?.subtitle?.subtitles || [];
      if (!list.length) return { text: '', langs: [] };
      const prefer = ['zh-CN', 'zh-Hans', 'ai-zh', 'zh-Hant', 'zh', 'en'];
      list.sort((a, b) => {
        const ia = prefer.indexOf(a.lan);
        const ib = prefer.indexOf(b.lan);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      let url = list[0].subtitle_url || '';
      if (url.startsWith('//')) url = `https:${url}`;
      if (!url) return { text: '', langs: list.map((s) => s.lan) };
      const res = await fetch(url, { headers: { 'user-agent': UA, referer: REFERER, cookie: header() }, signal: AbortSignal.timeout(20_000) });
      const j = await res.json();
      const text = (j.body || []).map((x) => String(x.content ?? '').trim()).filter(Boolean).join(' ');
      return { text: text.replace(/\s+/g, ' ').trim().slice(0, 20000), langs: list.map((s) => s.lan) };
    } catch (error) {
      return { text: '', langs: [], error: String(error?.message ?? error) };
    }
  }

  /** 下载一个低码率流（qn=32 约 480p；durl 直接给完整文件，不用合并）。 */
  async function download(m, dest) {
    const p = await sign({ bvid: m.bvid, cid: m.cid, qn: 32, fnval: 1, fourk: 0 });
    const pu = await api('https://api.bilibili.com/x/player/wbi/playurl', p);
    if (pu?.code !== 0) throw new Error(`playurl 失败：${pu?.code} ${pu?.message ?? ''}`);
    const durl = pu?.data?.durl || [];
    if (!durl.length) throw new Error('playurl 没返回可用流（可能受版权/权限限制）');
    const pick = durl.reduce((a, b) => (a.size <= b.size ? a : b));
    if (pick.size > maxBytes) throw new Error(`视频过大（${Math.round(pick.size / 1048576)}MB > ${Math.round(maxBytes / 1048576)}MB）`);
    const res = await fetch(pick.url, { headers: { 'user-agent': UA, referer: REFERER, cookie: header() }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return { bytes: buf.length, quality: pick.size, cid: m.cid, bvid: m.bvid };
  }

  return { api, meta, subtitles, download, hasLogin: Boolean(cookieMap.SESSDATA) };
}
