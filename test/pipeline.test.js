import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBiliCookieHeader, buildBiliDlpArgs } from '../src/pipeline.js';

test('Cookie 头：登录态 + buvid3，不重复', () => {
  assert.equal(buildBiliCookieHeader('SESSDATA=abc; bili_jct=def', ''), 'SESSDATA=abc; bili_jct=def');
  assert.equal(buildBiliCookieHeader('', 'B3-123'), 'buvid3=B3-123');
  assert.equal(buildBiliCookieHeader('SESSDATA=abc', 'B3-123'), 'SESSDATA=abc; buvid3=B3-123');
  // cookie 里已经有 buvid3 就不再追加
  assert.equal(buildBiliCookieHeader('buvid3=OLD; SESSDATA=abc', 'NEW'), 'buvid3=OLD; SESSDATA=abc');
  // 末尾多余分号会被清掉
  assert.equal(buildBiliCookieHeader('SESSDATA=abc; ', ''), 'SESSDATA=abc');
});

test('yt-dlp 参数：有 cookie 文件时必须带 --cookies', () => {
  const withCookies = buildBiliDlpArgs({ cookieFile: '/tmp/cookies.txt', maxDownload: 1024, outTemplate: '/tmp/x.%(ext)s', url: 'https://b23.tv/x' });
  const i = withCookies.indexOf('--cookies');
  assert.ok(i >= 0, '缺少 --cookies');
  assert.equal(withCookies[i + 1], '/tmp/cookies.txt');

  const without = buildBiliDlpArgs({ cookieFile: '', maxDownload: 1024, outTemplate: '/tmp/x.%(ext)s', url: 'https://b23.tv/x' });
  assert.equal(without.includes('--cookies'), false);
  // 体积上限与输出模板必须存在
  assert.ok(without.includes('--max-filesize'));
  assert.ok(without.includes('-o'));
});
