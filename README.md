# mcp-video-learn

> 让大模型**真的“看”**视频和动图：画面抽帧 + 字幕 + 一张网格图。

模型只认识文本和图片。你丢给它一个视频链接，它通常只能读到网页标题；丢给它一个表情包，
它只看到一串文件名。这个 MCP 服务把「视频 / 动图 / 图片」统一变成**模型一次就能读完的东西**：
一张按时间抽帧拼成的网格图，加上能拿到的字幕文本。

---

## 它提供三个工具

| 工具 | 做什么 | 输入 |
|---|---|---|
| `bili_video_info` | 只看元信息，不下载 | B 站链接 |
| `bili_video_watch` | 看 B 站视频：下载 → 抽帧 → 字幕 | B 站链接 |
| `media_frames` | 看**任意**动的东西：本地文件 / 直链 / B 站 | 路径、URL、B 站链接 |

```
判断值不值得看 → bili_video_info
看视频讲什么   → bili_video_watch
识别表情包     → media_frames("C:/stickers/怼脸.gif")
看视频结尾     → media_frames("D:/clips/live.mp4", strategy="recent")
```

---

## 安装（从 GitHub）

> **本项目没有发布到 npm。** 别用 `npm install -g mcp-video-learn`（会 404）。

```bash
# 1. 依赖：ffmpeg 必须在 PATH 里
ffmpeg -version

# 2. 拉代码
git clone https://github.com/hoholi-668/mcp-video-learn.git
cd mcp-video-learn
npm install --omit=optional          # sharp 是可选依赖，不装也能用

# 3. 试跑（出现 ready 就说明能启动）
node src/index.js
```

接到 MCP 客户端（以 DSH 为例）：

```yaml
- id: mcp-video-learn
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: video-learn
    transport: stdio
    command: node
    args: ['/绝对路径/mcp-video-learn/src/index.js']
    env:
      VIDEO_FFMPEG: /usr/bin/ffmpeg
      # 可选：B 站登录态（更高码率 / 受限视频）
      BILI_COOKIES: /path/to/bili-cookies.txt
```

> 其它 MCP 客户端（Claude Desktop / Cursor 等）同理：`command` 指向 node，
> `args` 指向 `src/index.js` 的**绝对路径**。

### 第一次用怎么开口

装好之后**不用记工具名**，直接说人话：

```
这个视频讲了什么 https://www.bilibili.com/video/BVxxxxxxx
帮我看看这个文件是什么 D:\clips\demo.mp4
这个动图里是什么 C:\stickers\blink.webp
```

---

## 支持哪些格式（先看这张表）

| 格式 | 能不能看 | 需要额外装东西吗 |
|---|---|---|
| **视频** `.mp4` `.mkv` `.webm` `.mov` `.flv` | ✅ 能 | 不需要 |
| **GIF 动图** `.gif` | ✅ **能（完全没问题）** | **不需要** |
| **静态图** `.png` `.jpg` `.webp`（单帧） | ✅ 能 | 不需要 |
| **动图 WebP** `.webp`（多帧） | ⚠️ 看情况 | **需要装 `sharp`**（或系统 ffmpeg 6.x） |

一句话：**GIF 和视频开箱即用；只有「动图 WebP」需要额外装一个 `sharp`。**

为什么动图 WebP 特殊：它是 Google 的格式，系统自带的 ffmpeg 4.x 只能读第一帧。
装上 `sharp` 就能逐帧看（`npm i sharp`）；装不上也没关系——其它格式照常工作，
只是动图 WebP 会明确告诉你缺什么，而不是给你一张黑图。

---

## 原理：九宫格不是“随便抽 9 帧”

底层是一个**容量固定的 FIFO 队列**：

```
画面进来 → 只有「画面发生明显变化」才入队 → 队列满了淘汰最旧的一帧（先进先出）
```

**为什么这么做**：一段 5 分钟的视频里可能 4 分钟是静止画面。均匀抽 9 帧会把 7 格
浪费在重复画面上；按“变化才入队”，这 9 格覆盖的是**全程最有代表性的 9 个瞬间**。

队列的两种取用方式（`strategy` 参数）：

| 策略 | 取什么 | 用来回答 |
|---|---|---|
| **`overview`（默认）** | 把变化点**均匀摊开**取 N 个 | “这视频讲了什么” |
| **`recent`** | **队列最终快照**（最近 N 个变化，FIFO 淘汰语义） | “现在在干嘛 / 结尾发生了什么” |

**同一套队列，同一个网格，换一个参数就是另一种视角。**

拿不到场景变化时（纯色画面、极短片段），自动退回均匀采样——**两种路径对调用方透明**，
返回文本里会写清楚这次用的是哪种（`mode=scene` / `mode=uniform`）。

### 同一套逻辑覆盖所有媒体

| 输入 | 帧数 | 取样方式 |
|---|---|---|
| 视频 | 9（3×3） | 画面变化 → FIFO 队列 |
| 动图 GIF | 6（3×2） | 按时长均分（一个循环正好铺满） |
| 静态图 | 1 | 原样 |

**调用方不需要知道自己拿到的是哪种媒体。**

---

## 三种输入，一个入口

`media_frames` 接受任意一种：

| 输入 | 例子 | 处理方式 |
|---|---|---|
| 本地文件 | `C:/stickers/怼脸.gif` | 必须在白名单目录内（见下方安全） |
| 媒体直链 | `https://x.com/a.gif` | 只接受媒体扩展名，限体积 |
| B 站链接 | `https://b23.tv/xxxx` | 走官方 API（见下节） |

---

## B 站：走官方 API，机房 IP 也能用

云服务器/机房 IP 抓 `www.bilibili.com` 会被 **412** 拦（cookie 也救不了，拦的是网页请求）。
所以本服务**不抓网页**，直接用官方接口：

```
view 接口   → 标题 / UP 主 / 时长 / cid
wbi 签名    → playurl 拿视频流地址
player/v2   → 字幕列表 → 下载字幕 JSON
直接下流    → ffmpeg 抽帧拼网格
```

`buvid3` 会自动向 `/x/frontend/finger/spi` 申请，**不登录也能取元信息**。

### 需要登录态时（可选）

想要更高码率、或视频有权限限制时，配一个小号 cookie（**务必用小号，不要用主号**）：

```bash
# 方式一：Netscape 格式的 cookies.txt
export BILI_COOKIES=/root/bili-cookies.txt

# 方式二：一行 cookie 串（脚本只保留必要的几个字段）
export BILI_COOKIE="$(node scripts/cookies-to-env.mjs /root/bili-cookies.txt)"
```

**怎么拿到 cookies**：

1. 用 Chrome / Edge 登录 B 站小号，打开 bilibili.com；
2. 装扩展 **Get cookies.txt LOCALLY**，点 Export → 得到 `cookies.txt`；
3. 传到服务器并收紧权限：

```bash
scp cookies.txt root@<host>:/root/bili-cookies.txt
ssh root@<host> "chmod 600 /root/bili-cookies.txt"
```

> cookie 等于登录态：**不要提交到 git、不要发到聊天里**。
> 没有 cookie 时元信息与大部分下载仍可用（`qn=32`，约 480p）。

---

## 动图 WebP 支持矩阵

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

---

## 配置项

全部通过环境变量，没有配置文件：

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIDEO_FFMPEG` | `ffmpeg` | ffmpeg 可执行文件 |
| `VIDEO_YTDLP` | `yt-dlp` | 仅作为 B 站 API 失败时的兜底 |
| `VIDEO_COOKIES` | — | 兼容旧名；等同 `BILI_COOKIES` |
| `BILI_COOKIES` | — | B 站 cookies.txt（Netscape 格式） |
| `BILI_COOKIE` | — | B 站 cookie 串（`SESSDATA=...; bili_jct=...`） |
| `VIDEO_AUDIT` | `~/.cache/mcp-video-learn/audit.jsonl` | 审计日志 |
| `VIDEO_MAX_MB` | `60` | 单次下载体积上限（MB） |
| `VIDEO_ALLOW_ROOTS` | 当前目录 + 临时目录 | `media_frames` 允许读取的本地目录（路径分隔符分隔） |
| `SHARP_MODULE` | — | 复用宿主已装的 sharp |

---

## 实测数据与验证

这个插件的“能跑”不是推测，是分层跑出来的：

| 层 | 命令 | 覆盖 | 结果 |
|---|---|---|---|
| 单元 | `npm test` | FIFO 队列语义、URL 校验、网格计算、cookie 头拼装 | **20/20** |
| 真实媒体矩阵 | `npm run selftest:matrix` | mp4/gif/webp/png、1s~40s、横竖屏、frames 1~12、tileWidth 64~640、坏文件、白名单 | **69/69** |
| MCP 协议 | `npm run selftest:mcp` | 真实拉起服务、列工具、调工具、拒非法输入、真实 B 站 watch | **8/8** |

**性能（服务器实测，5 分钟 640×360 视频）**：场景检测 **3.1 秒**，生成九宫格 **9.2 秒**。
**B 站真实视频**：3 分 33 秒的 MV，下载 10 MB / 10.5 秒，9 帧网格 + 522 字字幕。

### 踩过并修掉的坑（写给后来的人）

1. **ffmpeg 4.4 没有 `-fps_mode`** —— 会报 `Unrecognized option`，必须用 `-vsync vfr`；插件自动探测版本。
2. **`select=gt(scene,…)` 只比亮度** —— 红→绿这种“亮度接近、色度差异大”的切换会整段漏掉。
   改用 `tblend` 差分 + `signalstats` 取 Y/U/V 最大值。
3. **`tile` 必须凑满 cols×rows 才输出** —— 场景点不足时要补均匀时间点，否则一张图都出不来。
4. **机房 IP 抓 B 站网页 412** —— 元信息与下载都改走官方 API（带 `buvid3`）。
5. **ffmpeg 4.4 解不开动图 WebP** —— 用 sharp 兜底；坏文件会被识破（libvips 会把残缺文件解成空白页却不报错）。
6. **同一功能写了两份实现** —— 测试测的是 A 文件、服务跑的是 B 文件；现在统一到 `src/pipeline.js`。

---

## 遇到问题

先看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)：按症状查原因和处理方法。

## 已知限制

- **动图 WebP** 需要 `sharp` 或 ffmpeg ≥ 6.x。
- **B 站**：走 API 可下 480p；更高清晰度/会员内容需要登录 cookie。
- 抽帧是**采样**，不是逐帧分析：极长的视频只能看到代表点。
- 字幕只反映台词/讲解；纯语音或音乐视频拿不到内容。
- 只读：不下载到用户目录、不上传、不发布任何内容。

---

## 安全边界

| 措施 | 目的 |
|---|---|
| 本地路径白名单（`VIDEO_ALLOW_ROOTS`） | 防止变成任意文件读取器 |
| 直链只认媒体扩展名 | 防止变成通用下载器 |
| 体积上限（`VIDEO_MAX_MB`） | 防止磁盘/带宽被打满 |
| 步骤超时 | 防止卡死 |
| 审计日志（本地） | 每次调用留痕 |
| 只接受 `bilibili.com` / `b23.tv` | 链接白名单 |

---

## 开发

```
src/index.js      MCP 服务：工具注册与参数校验
src/pipeline.js   抽帧管线：场景检测 / FIFO 队列 / 网格生成（可独立测试）
src/filmstrip.js  固定容量队列与两种取用策略（纯函数）
src/media.js      格式判定、网格计算、ffprobe 结果归一（纯函数）
src/bili-api.js   B 站官方 API：wbi 签名、playurl、字幕（机房 IP 可用）
src/webp-sharp.js 动图 WebP 的 sharp 解码（可选依赖）
src/lib.js        URL 校验、字幕清洗、时长格式化（纯函数）
scripts/          三层自测 + cookie 转换工具
test/             node:test
```

```bash
npm test                    # 单元测试
npm run selftest:matrix     # 真实媒体矩阵（需要 ffmpeg）
npm run selftest:mcp        # MCP 协议层（需要依赖已装）
```

---

## 许可

MIT © 2026 HOHOLI

## 兼容范围

| 项 | 要求 | 实测情况 |
|---|---|---|
| **操作系统** | Linux / Windows / macOS | Linux ✅ 全测；Windows 🟡 单测通过、媒体矩阵未测；macOS ⬜ 未测 |
| **Node.js** | `>= 20` | 20 / 22 / 24 都跑过单测；CI 覆盖 20、22 |
| **ffmpeg** | `>= 4.4` | 4.4.2（Ubuntu 22.04）、CI 最新版都通过（自动适配 `-fps_mode` / `-vsync`） |
| **ffprobe** | 随 ffmpeg | 同上 |
| **yt-dlp** | 可选 | 只有 B 站网页被 412 时才需要兜底 |
| **sharp** | 可选 | 只有动图 WebP 需要；没有会明确报错 |

### AI 客户端（Harness）

标准 MCP stdio 服务，不绑定某个客户端：

| 客户端 | 状态 |
|---|---|
| DSH 0.1.x / 0.2.x | ✅ 实测（`@deepseek-ai/dsh-mcp-client`） |
| Claude Desktop / Cursor / Cline | 🟡 推断可用（标准 stdio），未实测 |
| 纯 CLI 客户端 | 🟡 能调工具，但**图片可能被丢弃**，只剩文字元信息 |

> `media_frames` 返回的是 base64 图片。客户端不支持 image content 时，你只能看到
> 「尺寸 / 帧数 / 取帧方式」，看不到九宫格——工具没错，是显示层差异。

### 平台注意

- **Windows**：`VIDEO_ALLOW_ROOTS` 用**分号**分隔，例如 `C:\videos;D:\clips`
- **ffmpeg 路径**：可用 `VIDEO_FFMPEG` 指到绝对路径（兼容 `ffmpeg.exe`）
- **macOS**：代码无平台专属逻辑，但**没实测过**

### 自测你的环境

```bash
node --test                              # 单测（20 项）
node scripts/selftest-matrix.mjs /tmp/m   # 媒体矩阵（需要 ffmpeg，68 项）
```