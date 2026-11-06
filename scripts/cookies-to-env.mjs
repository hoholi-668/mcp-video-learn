#!/usr/bin/env node
// 把浏览器导出的 cookies.txt（Netscape 格式）转成一行 Cookie 串，
// 方便设置 BILI_COOKIE（给官方 API 用）。yt-dlp 则直接用文件本身（BILI_COOKIES）。
//
// 用法：
//   node scripts/cookies-to-env.mjs /root/bili-cookies.txt
//   BILI_COOKIE="$(node scripts/cookies-to-env.mjs /root/bili-cookies.txt)" node ...
//
// 输出只包含 B 站需要的几个字段（SESSDATA / bili_jct / DedeUserID / buvid3），
// 避免把一大堆无关 cookie 带进请求头。

import fs from 'node:fs';

const KEEP = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4']);

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/cookies-to-env.mjs <cookies.txt>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`文件不存在：${file}`);
  process.exit(1);
}

const text = fs.readFileSync(file, 'utf8');
const pairs = [];
for (const line of text.split('\n')) {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) continue;
  // Netscape 格式：domain \t flag \t path \t secure \t expiry \t name \t value
  const cols = raw.split('\t');
  if (cols.length >= 7) {
    const name = cols[5].trim();
    const value = cols[6].trim();
    if (KEEP.has(name) && value) pairs.push(`${name}=${value}`);
    continue;
  }
  // 也兼容直接粘贴的 "a=b; c=d" 形式
  for (const kv of raw.split(';')) {
    const [k, ...rest] = kv.split('=');
    const key = (k || '').trim();
    const val = rest.join('=').trim();
    if (KEEP.has(key) && val) pairs.push(`${key}=${val}`);
  }
}

const uniq = [...new Set(pairs)];
if (!uniq.length) {
  console.error('没有找到 B 站登录相关的 cookie（SESSDATA / bili_jct 等）。确认导出的是 bilibili.com 的 cookie。');
  process.exit(2);
}
// 只输出 cookie 串本身，方便 $(...) 直接替换
process.stdout.write(uniq.join('; '));
console.error(`\n[已提取 ${uniq.length} 个字段]`);
