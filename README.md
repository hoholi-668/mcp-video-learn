# mcp-video-learn

让大模型**真的“看”**视频和动图：元信息、画面抽帧、字幕。

> 为什么需要这个：模型只能读文本和图片。视频、GIF 表情包在它眼里只是一串文件。
> 这个 MCP 把它们变成模型能吃的东西——**一串按时间抽出的画面 + 文本**。

## 它做什么

| 工具 | 作用 | 输入 |
|---|---|---|
| `bili_video_info` | 只看元信息，不下载 | B 站链接 |
| `bili_video_watch` | 看 B 站视频：画面抽帧 + 字幕 | B 站链接 |
| **`media_frames`** | **看任意动的东西**：本地 GIF/WebP/视频、媒体直链、B 站 | 路径 / 直链 / B 站 |

**典型用法**：

```
判断值不值得看 → bili_video_info
看视频内容     → bili_video_watch
识别表情包     → media_frames("C:/stickers/怼脸.gif")
看视频结尾     → media_frames("D:/clips/live.mp4", strategy="recent")
```

## 支持哪些格式（先看这张表）

| 格式 | 能不能看 | 需要额外装东西吗 |
|---|---|---|
| **视频** `.mp4` `.mkv` `.webm` `.mov` `.flv` | 能 | 不需要 |
| **GIF 动图** `.gif` | **能（完全没问题）** | **不需要** |
| **静态图** `.png` `.jpg` `.webp`（单帧） | 能 | 不需要 |
| **动图 WebP** `.webp`（多帧） | 看情况 | **需要装 `sharp`**（或系统 ffmpeg 6.x） |

一句话：**GIF 和视频开箱即用；只有「动图 WebP」需要额外装一个 `sharp`。**

为什么动图 WebP 特殊：它是 Google 的格式，系统自带的 ffmpeg 4.x 只能读第一帧。
装了 `sharp` 之后就能逐帧看（`npm i sharp`）；装不上也没关系——其它格式照常工作，
只是动图 WebP 会明确告诉你缺什么，而不是给你一张黑图。


## 核心：九宫格不是“随便抽 9 帧”

底层是一个**容量固定的 FIFO 队列**：

```
画面进来 → 只有「画面发生明显变化」才入队 → 队列满了淘汰最旧的一帧（先进先出）
```

**为什么这么做**：一段 5 分钟的视频里可能 4 分钟是静止画面。
均匀抽 9 帧会把 7 格浪费在重复画面上；按“变化才入队”，这 9 格覆盖的是**全程最有代表性的 9 个瞬间**。

队列的两种取用方式（`strategy` 参数）：

| 策略 | 取什么 | 用来回答 |
|---|---|---|
| **`overview`（默认）** | 把变化点**均匀摊开**取 N 个 | “这视频讲了什么” |
| **`recent`** | **队列最终快照**（最近 N 个变化，FIFO 淘汰语义） | “现在在干嘛 / 结尾发生了什么” |

**同一套队列，同一个网格，换一个参数就是另一种视角。**

拿不到场景检测结果时（比如纯色背景动画），自动退回均匀采样——**两种路径对调用方透明**。

## 同一套逻辑覆盖所有媒体

| 输入 | 队列容量 | 取样方式 |
|---|---|---|
| 视频（.mp4/.mkv/.webm…） | 9（3×3） | 场景变化 → FIFO 队列 |
| 动图（.gif/.webp/.apng） | 6（3×2） | 按时长均分（一个循环正好铺满） |
| 静态图（.png/.jpg） | 1 | 原样 |

**调用方不需要知道自己拿到的是哪种媒体。**

## 速览：它给模型的东西长什么样

```
来源：local（怼脸.gif）
类型：image（动图/视频）
尺寸：320×240 · 共 48 帧 · 4.8 秒
画面：6 帧拼成 3×2 网格（行优先 左上→右下）
取帧：场景变化检测（全程均匀覆盖），命中 6 个变化点
```

外加一张每帧 `240px` 宽的网格图。

## 安装

### 1. 依赖

```bash
# yt-dlp 与 ffmpeg 必须在 PATH 里（或用环境变量指定路径）
yt-dlp --version
ffmpeg -version
```

### 2. 装本服务

```bash
npm install -g mcp-video-learn
```

或者不装，直接用 `npx`。

### 3. 接到你的 MCP 客户端

以 DSH 为例（`cordis.patch.yml` 里加一行）：

```yaml
- id: mcp-video-learn
  name: '@deepseek-ai/dsh-mcp'
  config:
    command: npx
    args: ['-y', 'mcp-video-learn']
    env:
      VIDEO_YTDLP: /usr/local/bin/yt-dlp
      VIDEO_FFMPEG: /usr/bin/ffmpeg
```

其它客户端（Claude Desktop 等）同理：`command` + `args` 指向本服务即可。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIDEO_YTDLP` | `yt-dlp` | yt-dlp 可执行文件 |
| `VIDEO_FFMPEG` | `ffmpeg` | ffmpeg 可执行文件 |
| `VIDEO_COOKIES` | `~/.config/mcp-video-learn/cookies.txt` | 取字幕用；没有则只抽帧 |
| `VIDEO_AUDIT` | `~/.cache/mcp-video-learn/audit.jsonl` | 审计日志 |
| `VIDEO_MAX_MB` | `60` | 单次下载体积上限（MB） |
| `VIDEO_ALLOW_ROOTS` | 当前目录 + 临时目录 | `media_frames` 允许读取的本地目录，用路径分隔符隔开（Windows `;`，Linux/macOS `:`） |

## 动图 / GIF 表情包

`media_frames` 是为这个场景设计的：

- **默认抽 6 帧（3×2）**——动图通常很短，6 帧足够看出动作，又不至于每帧小到看不清；
- 自动用 `ffprobe` 读出真帧数和时长，**在文本里明确告诉模型“这是动图”**（否则模型会以为是一张静态图）；
- 静态图也能传，会按 1 帧处理。

**为什么要拼网格而不是发多张图**：一条消息塞多张图，每张都占一次模型请求配额；
拼成一张网格只占一次，token 也更省。

## 关于字幕

**B 站的 AI 字幕通常需要登录才能取。**

做法：浏览器登录 B 站 → 用扩展导出 `cookies.txt` → 放到
`~/.config/mcp-video-learn/cookies.txt`（或 `VIDEO_COOKIES` 指定的位置）。

没有 cookies 也能用，只是**没有字幕文本**——画面还在，但纯语音讲解的内容会缺失。

## 限制（重要）

- **只支持 B 站**（`bilibili.com` / `b23.tv`）。这是刻意的：避免被当成任意视频下载器。
- 下载限 **480p 以下**、单次最多 **60MB**，只够“看懂大意”，不适合看细节。
- 抽帧是**均匀采样**，快速镜头/关键帧可能被跳过。
- 步骤超时 **120 秒**；长视频可能失败。
- 只读，不下载、不发布任何内容。

## 实现

```
src/lib.js     纯函数（URL 校验、时长格式化、字幕清洗、网格计算）—— 有单测
src/index.js   MCP 服务：调用 yt-dlp / ffmpeg，把结果整理成 text + image
test/          node:test，不需要网络和 yt-dlp
```

跑测试：

```bash
npm test
```

## 安全设计

| 措施 | 目的 |
|---|---|
| 域名白名单 | 只接受 B 站，防止被当成任意下载器 |
| 体积上限 | 防止磁盘/带宽被吃光 |
| 步骤超时 | 防止卡死 |
| 审计日志 | 每次调用留痕（本地） |

## 许可

MIT © 2026 HOHOLI
## 验证过的场景（真跑，不是"应该能行"）

自测分三层，全部在 Linux 服务器上真实执行：

| 层 | 命令 | 覆盖 | 结果 |
|---|---|---|---|
| 单元 | `npm test` | 队列语义、URL 校验、网格计算 | 18/18 |
| 真实媒体矩阵 | `npm run selftest:matrix` | mp4/gif/webp/png、1s~40s、横竖屏、frames 1~12、tileWidth 64~640、坏文件、白名单 | 68/68 |
| MCP 协议 | `npm run selftest:mcp` | 真实拉起服务、列工具、调工具、拒非法输入 | 8/8 |

### 实测发现并修掉的问题（都写在这里，避免后人重踩）

1. **ffmpeg 4.4 没有 `-fps_mode`** —— 用它会报 `Unrecognized option`，必须用 `-vsync vfr`；插件会自动探测版本。
2. **`select=gt(scene,…)` 只比亮度** —— 红→绿这种"亮度接近、色度差异大"的切换会整段漏掉。改用 `tblend` 差分 + `signalstats` 取 Y/U/V 最大值。
3. **`tile` 滤镜必须凑满 cols×rows 才输出** —— 场景点不足时补均匀时间点，否则一张图都出不来。
4. **机房 IP 直连 B 站 412** —— 元信息改走官方 API（需要 `buvid3` cookie，会自动去 `finger/spi` 取）。
5. **ffmpeg 4.4 解不开动图 WebP** —— 会给出明确报错而不是黑图；静态 WebP 正常。

### 性能

5 分钟 640×360 视频（服务器实测）：场景检测 **3.1 秒**、生成九宫格 **9.2 秒**。

## 已知限制

- **动图 WebP** 需要 ffmpeg ≥ 6.x（4.4 只支持静态 WebP）。
- **B 站视频下载** 需要非机房 IP（家宽/代理）；元信息可以走 API，但下载仍要能访问网页。
- 抽帧是**采样**，不是逐帧分析：极长的视频只能看到代表点。
- 只读：不下载、不上传、不发布任何内容。
## B 站登录态（小号方案）

机房/云服务器直连 B 站会被 **412** 拦。用一个小号登录后导出 cookie，可以让元信息
和下载都恢复正常（**务必用小号，不要用主号**）：

```bash
# 1) 浏览器登录 B 站小号，用扩展导出 cookies.txt（Netscape 格式）
# 2) 指给插件：
export BILI_COOKIES=/path/to/cookies.txt        # 给 yt-dlp 下载用
export BILI_COOKIE="SESSDATA=...; bili_jct=..." # 给官方 API 用（元信息）
```

| 变量 | 作用 | 没有会怎样 |
|---|---|---|
| `BILI_COOKIES` | yt-dlp `--cookies` | 下载可能 412 |
| `BILI_COOKIE` | API Cookie 头 | 元信息可能 412 |

> 没有 cookie 时：**元信息仍走 API**（自动取 `buvid3` 绕过 412），大多数公开视频能拿到标题/时长；
> 只有下载仍需要能访问网页的出口 IP。

## 动图 WebP 支持矩阵

ffmpeg 4.x 的解码器只认静态 WebP，动图 WebP 需要另一条路：

| 情况 | 行为 |
|---|---|
| 静态 WebP | ✅ ffmpeg 直接处理 |
| 动图 WebP + **装了 sharp** | ✅ 逐帧解码后拼网格（`mode=webp-sharp`） |
| 动图 WebP + **没装 sharp** | ❌ 明确报错，告诉你装什么 |
| 动图 WebP + **ffmpeg 6.x** | ✅ 走 ffmpeg 正常路径 |
| **坏掉的 WebP** | ❌ 识破并报错（不会输出一张空白图） |

装 sharp（可选依赖，不装也能用其它格式）：

```bash
npm i sharp
# 或者复用宿主里已装的 sharp：
export SHARP_MODULE=/path/to/node_modules/sharp
```

**为什么值得装**：QQ / 微信里的表情包很多是动图 WebP；不装的话这类表情只能看到报错。
