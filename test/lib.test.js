import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBiliUrl, fmtDuration, subtitlesToText, gridFor, pickVideoFile } from '../src/lib.js';

test('只接受 B 站链接', () => {
  assert.ok(normalizeBiliUrl('https://www.bilibili.com/video/BV1xx411c7mD'));
  assert.ok(normalizeBiliUrl('https://b23.tv/abc123'));
  assert.equal(normalizeBiliUrl('https://evil.com/video.mp4'), null);
  assert.equal(normalizeBiliUrl('javascript:alert(1)'), null);
  assert.equal(normalizeBiliUrl(''), null);
  // 子域名也算 B 站
  assert.ok(normalizeBiliUrl('https://m.bilibili.com/video/BV1xx'));
  // 但伪造域名不行
  assert.equal(normalizeBiliUrl('https://bilibili.com.evil.com/v'), null);
});

test('时长格式化', () => {
  assert.equal(fmtDuration(0), '0秒');
  assert.equal(fmtDuration(45), '45秒');
  assert.equal(fmtDuration(60), '1分0秒');
  assert.equal(fmtDuration(83), '1分23秒');
  assert.equal(fmtDuration('bad'), '0秒');
});

test('字幕转文本：去时间轴、去标签、去连续重复', () => {
  const vtt = [
    'WEBVTT',
    '',
    '1',
    '00:00:01.000 --> 00:00:03.000',
    '第一句',
    '第一句',
    '00:00:04.000 --> 00:00:06.000',
    '<b>第二句</b>'
  ].join('\n');
  assert.equal(subtitlesToText(vtt), '第一句 第二句');
});

test('网格：9 帧用 3 列，4 帧用 2 列', () => {
  assert.deepEqual(gridFor(9), { want: 9, cols: 3, rows: 3 });
  assert.deepEqual(gridFor(4), { want: 4, cols: 2, rows: 2 });
  // 越界值会被夹住；0/空值回落到默认 9 帧（4~12 的下限由工具 schema 保证）
  assert.equal(gridFor(99).want, 12);
  assert.equal(gridFor(0).want, 9);
  assert.equal(gridFor(1).want, 1);
});

test('挑视频文件：只认视频扩展名', () => {
  assert.equal(pickVideoFile(['/tmp/a.mp4', '/tmp/b.txt']), '/tmp/a.mp4');
  assert.equal(pickVideoFile(['/tmp/a.txt']), null);
  assert.equal(pickVideoFile([]), null);
});
