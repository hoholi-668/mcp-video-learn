import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { guessKind, pickFrames, gridForFrames, tileFilter, isUnderRoots, isDirectMediaUrl, describeProbe } from '../src/media.js';

test('按扩展名判类型', () => {
  assert.equal(guessKind('a.gif'), 'image');
  assert.equal(guessKind('a.WebP'), 'image');
  assert.equal(guessKind('a.mp4'), 'video');
  assert.equal(guessKind('a.png'), 'still');
  assert.equal(guessKind('a.txt'), 'unknown');
  assert.equal(guessKind(''), 'unknown');
});

test('默认帧数：动图 6，视频 9', () => {
  assert.equal(pickFrames('image'), 6);
  assert.equal(pickFrames('video'), 9);
  assert.equal(pickFrames('image', 10), 10);
  // 越界夹住
  assert.equal(pickFrames('video', 99), 12);
  assert.equal(pickFrames('video', 0), 9);
});

test('网格：6 帧 3×2，9 帧 3×3', () => {
  assert.deepEqual(gridForFrames(6), { want: 6, cols: 3, rows: 2 });
  assert.deepEqual(gridForFrames(9), { want: 9, cols: 3, rows: 3 });
  assert.deepEqual(gridForFrames(4), { want: 4, cols: 2, rows: 2 });
});

test('tile 滤镜参数合法', () => {
  const f = tileFilter({ cols: 3, rows: 2 }, { tileWidth: 240 });
  assert.match(f, /scale=240:-1/);
  assert.match(f, /tile=3x2/);
  // 宽度被夹在 64~640
  assert.match(tileFilter({ cols: 3, rows: 2 }, { tileWidth: 5000 }), /scale=640/);
  assert.match(tileFilter({ cols: 3, rows: 2 }, { tileWidth: 1 }), /scale=64/);
});

test('本地路径白名单', () => {
  const roots = [path.resolve('C:/work'), path.resolve('C:/tmp')];
  assert.ok(isUnderRoots(path.resolve('C:/work/a.gif'), roots));
  assert.ok(isUnderRoots(path.resolve('C:/work/sub/a.gif'), roots));
  assert.equal(isUnderRoots(path.resolve('C:/windows/system32/x.dll'), roots), false);
  // 前缀相同的兄弟目录不算（避免 C:/work2 被当 C:/work）
  assert.equal(isUnderRoots(path.resolve('C:/work2/a.gif'), roots), false);
});

test('直链只认媒体扩展名', () => {
  assert.ok(isDirectMediaUrl('https://x.com/a.gif'));
  assert.ok(isDirectMediaUrl('https://x.com/a.mp4'));
  assert.ok(isDirectMediaUrl('https://x.com/a.webp'));
  assert.equal(isDirectMediaUrl('https://x.com/a.exe'), false);
  assert.equal(isDirectMediaUrl('ftp://x.com/a.gif'), false);
  assert.equal(isDirectMediaUrl('not a url'), false);
});

test('ffprobe 结果归一', () => {
  const gif = describeProbe({
    streams: [{ codec_type: 'video', width: 320, height: 240, nb_frames: '48' }],
    format: { duration: '4.8', format_name: 'gif' }
  });
  assert.equal(gif.width, 320);
  assert.equal(gif.frames, 48);
  assert.equal(gif.animated, true);
  assert.equal(gif.format, 'gif');

  const still = describeProbe({ streams: [{ codec_type: 'video', width: 800, height: 600, nb_frames: '1' }], format: { duration: '0' } });
  assert.equal(still.still, true);
  assert.equal(still.animated, false);
});
