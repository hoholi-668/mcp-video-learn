# 10 分钟接入 DSH

> 目标：在一个全新的 DSH 上，从零接好 `mcp-video-learn`，并让她真的看到一段视频。
> 不需要 QQ、不需要任何 IM 网关——这是纯 MCP 插件。

---

## 0. 前置检查

```bash
node -v          # >= 20
ffmpeg -version  # >= 4.4，必须在 PATH 里
```

没有 ffmpeg 就先装：

```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y ffmpeg
# macOS
brew install ffmpeg
# Windows（任选其一）
winget install ffmpeg
choco install ffmpeg
```

---

## 1. 装插件

```bash
git clone https://github.com/hoholi-668/mcp-video-learn.git
cd mcp-video-learn
npm install --omit=optional      # sharp 可选，不装也能用其它格式
node src/index.js                # 看到 ready 就说明能启动，Ctrl+C 退出
```

---

## 2. 注册到 DSH

编辑 DSH profile 的 `cordis.patch.yml`（通常在 `~/.dsh/profiles/<profile>/cordis.patch.yml`），加一段：

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
      # 本地文件白名单（不设就只能看临时目录）
      VIDEO_ALLOW_ROOTS: /data/clips:/tmp
      # 可选：B 站登录态
      # BILI_COOKIES: /root/bili-cookies.txt
```

重启 DSH：

```bash
dsh restart        # 或你的部署方式：systemctl restart dsh-web
```

**验证**：DSH 里问一句「你有哪些工具」，能看到 `media_frames` / `bili_video_watch` 等 4 个。

---

## 3. 第一次用（三句话就够）

```
这个视频讲了什么 https://www.bilibili.com/video/BV1GJ411x7h7
帮我看看这个文件是什么 /data/clips/demo.mp4
这个动图里是什么 /data/stickers/blink.gif
```

**不需要说工具名**——模型会自己选。

---

## 4. 验证是否真的在看

| 现象 | 说明 |
|---|---|
| 回复里带「九宫格」「尺寸/帧数/时长」 | ✅ 工具被调用 |
| 能说出画面里的字、颜色、人物动作 | ✅ 真的看到了图 |
| 只说「这是一个视频」 | ❌ 没调工具，检查 DSH 工具列表 |

**看日志**（可选）：

```bash
tail -f ~/.cache/mcp-video-learn/audit.jsonl
# 每次调用一行：{"tool":"media_frames","kind":"video","ok":true,...}
```

---

## 5. 常见问题

| 症状 | 原因 | 处理 |
|---|---|---|
| `ffmpeg 解不开这个文件` | 文件损坏或不是媒体 | 换文件；`ffprobe` 先验 |
| `拒绝：本地路径不在白名单` | `VIDEO_ALLOW_ROOTS` 没包含该目录 | 加上目录（Windows 用 `;` 分隔） |
| `动图 WebP` 报缺 sharp | 没装可选依赖 | `npm i sharp` 或设 `SHARP_MODULE` |
| B 站 412 | 网页通道被风控 | 插件会走 API；看错误里 API 那行 |
| 客户端看不到图 | 客户端不支持 image content | 换 DSH/Claude 这类支持图片的客户端 |

---

## 6. 下一步

- 想看长视频分段：`media_frames(..., chunks=3~6)`
- 只有标题没有链接：`bili_search("标题")` 再 `bili_video_watch`
- 想接人物名册 / 发言节奏：见 [mcp-roster](https://github.com/hoholi-668/mcp-roster) 与 [conversation-pacing](https://github.com/hoholi-668/conversation-pacing)
