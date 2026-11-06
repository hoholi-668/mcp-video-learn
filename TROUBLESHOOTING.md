# 排错手册

> 按「症状」找，不用从头读。

---

## 装不上 / 起不来

### `ffmpeg: command not found`

**原因**：没装 ffmpeg，或不在 PATH 里。

```bash
# Ubuntu / Debian
sudo apt install -y ffmpeg
# macOS
brew install ffmpeg
# Windows：下载后把 bin 目录加进 PATH
```

或者直接指定绝对路径：

```bash
export VIDEO_FFMPEG=/usr/local/bin/ffmpeg
```

**预防**：`ffmpeg -version` 能跑再装本服务。

### `Cannot find package '@modelcontextprotocol/sdk'`

**原因**：依赖没装，或用 `node src/index.js` 直接跑但仓库里没有 `node_modules`。

```bash
npm install
```

### Node 版本太低

**要求**：Node ≥ 20（用了 `AbortSignal.timeout`、`fetch` 等）。

```bash
node -v   # 小于 20 就需要升级
```

---

## 视频 / 图片看不到

### 「ffmpeg 解不开这个文件」

| 可能原因 | 怎么确认 | 处理 |
|---|---|---|
| 文件损坏 | `ffprobe 文件` 报错 | 换文件 |
| 扩展名骗人（`.mp4` 其实是文本） | `file 文件` 显示 text | 换文件 |
| 编码不支持 | `ffprobe` 显示陌生 codec | 换 ffmpeg 版本或用支持的编码 |

### 「解不开这个 WebP：当前 ffmpeg 只支持静态 WebP」

**原因**：ffmpeg 4.x 只能读静态 WebP，动图 WebP 需要 sharp 或 ffmpeg ≥ 6。

```bash
npm i sharp
# 或者复用已装的：
export SHARP_MODULE=/path/to/node_modules/sharp
```

**预防**：用 GIF 代替动图 WebP，或升级 ffmpeg。

### 「解出来的 N 帧全是空白」

**这是正确行为**，不是 bug。libvips 会把残缺的 WebP 解成若干空白页而不报错，
插件主动识破并拒绝，避免给你一张空白图。

**处理**：文件坏了，换一个。

### 网格图只有一部分 / 全是同一画面

| 原因 | 处理 |
|---|---|
| 视频太短（< 1 秒） | 正常，会退回均匀采样 |
| 画面完全静止 | 正常，`mode=uniform` |
| 场景点不足 | 插件会自动补均匀时间点；仍异常就调大 `frames` 或换 `strategy` |

---

## B 站相关

### 「B 站网页接口返回 412」

**原因**：机房/云服务器 IP 抓网页被拦。

**处理**：本插件的 B 站路径**不走网页**，直接调官方 API（`view` + `playurl`）。
如果你看到 412，说明走到了 yt-dlp 兜底路径——检查是否：

- 版本太老（0.7.0 之前只有 yt-dlp）
- 视频本身受限（需要登录）

### 「playurl 没返回可用流」

| 原因 | 处理 |
|---|---|
| 视频需要登录/大会员 | 配 `BILI_COOKIES`（小号） |
| 视频已删除/私密 | 换视频 |
| wbi 签名失效（B 站改规则） | 更新插件版本 |

### cookie 过期

**症状**：`view` 接口报 -101（未登录）或下载 403。

**处理**：重新导出 cookies.txt（见 README「怎么拿到 cookies」）。

**预防**：cookie 有效期通常几个月；过期就换，不要用主号。

### 「没有可用字幕轨」

**不是 bug**。B 站很多视频没有字幕（尤其音乐、纯画面）。

---

## 输入被拒绝

### 「本地路径不在白名单目录内」

**原因**：安全边界。默认只允许当前目录 + 临时目录。

```bash
export VIDEO_ALLOW_ROOTS="/home/me/videos:/tmp"
```

**注意**：用路径分隔符（Linux `:` / Windows `;`）分隔多个目录。

### 「只支持媒体扩展名」

直链只接受 `.mp4/.gif/.webp/.png/.jpg` 等；`.exe`、无扩展名的链接会被拒。

### 「视频过大」

```bash
export VIDEO_MAX_MB=200   # 默认 60
```

**注意**：调大后下载会更慢，也可能撑爆磁盘。

---

## 性能

### 长视频很慢

| 视频长度 | 大致耗时（实测 640×360） |
|---|---|
| 5 分钟 | 场景检测 3 秒 + 出图 9 秒 |
| 30 分钟 | 可能 1~2 分钟，接近默认超时 |

**处理**：调大 `frames` 不会更快；要快就剪短视频，或把 `VIDEO_FFMPEG` 换成更快的编码。

### 内存占用高

大分辨率视频（4K）解码会吃内存。**处理**：转成 720p 再喂。

---

## macOS / Windows 特有

| 问题 | 处理 |
|---|---|
| Windows 路径带空格 | 用引号包住，或设 `VIDEO_FFMPEG` 为完整路径 |
| macOS 没有 ffmpeg | `brew install ffmpeg` |
| Windows 出现 HTTP 代理错误 | 关掉系统代理，或让 Node 走同一代理 |

---

## 还是不行

1. 看审计日志：`~/.cache/mcp-video-learn/audit.jsonl`
2. 手动确认 ffmpeg 能处理这个文件：

```bash
ffprobe 你的文件
ffmpeg -v error -i 你的文件 -vf "select='between(t,0,1)'" -frames:v 1 /tmp/test.jpg
```

3. 两条命令都失败 → 文件或 ffmpeg 的问题，不是插件。
4. 都成功但插件失败 → 提 issue，附上：
   - `ffmpeg -version`
   - 出错的完整返回文本
   - 文件类型（`file 文件`）
