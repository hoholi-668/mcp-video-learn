# mcp-video-learn

让大模型**真的“看”**一个 B 站视频的 MCP 服务：元信息、画面抽帧、字幕。

> 为什么需要这个：模型只能读文本和图片。你丢给它一个视频链接，它通常只能看到网页标题。
> 这个 MCP 把链接变成模型能吃的东西——**一串按时间均匀抽出的画面 + 字幕文本**。

## 它做什么

| 工具 | 作用 | 输出 |
|---|---|---|
| `bili_video_info` | 只看元信息，不下载 | 标题、UP 主、时长、简介、有没有字幕 |
| `bili_video_watch` | 真正“看” | 9 帧拼成 3×3 网格（图）+ 字幕全文（文本） |

典型用法：先 `bili_video_info` 判断值不值得看，再 `bili_video_watch` 看内容。

## 速览：它给模型的东西长什么样

```
标题：xxxxx
UP 主：xxxxx
时长：3分12秒
画面：已抽 9 帧拼成 3×3 网格（行优先 左上→右下，均匀覆盖整段）
字幕：已获取 1200 字，全文在下方

【字幕全文】
……
```

外加一张 `320px` 宽的画面拼图。

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
