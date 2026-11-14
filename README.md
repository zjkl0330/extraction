# Extraction

多平台短视频/图片无水印解析下载工具（Cloudflare Worker），支持 **TikTok、抖音、快手、小红书、哔哩哔哩、YouTube、Instagram** 共 7 大平台。基于 Cloudflare Workers + 静态资源（Worker Static Assets）+ Browser Rendering 无头浏览器部署，含速率限制与平台级代理下载。

> 📌 本工具为**公开访问**，无需令牌即可使用解析接口；抖音解析内置 Cloudflare 无头浏览器渲染兜底。

---

## ✨ 功能特性

- **多平台解析**：自动识别链接所属平台并调用对应解析器。
- **无水印下载**：优先返回去除平台水印的直链，交由服务端代理下载。
- **图片图集支持**：抖音 / TikTok / 快手 / 小红书 / Instagram 图集可批量下载。
- **视频 & 音乐**：TikTok / 抖音支持同时提取视频与背景音乐。
- **无头浏览器兜底**：抖音解析优先走 Cloudflare Browser Rendering（Puppeteer）真实渲染，破解空壳页；失败降级为普通抓取。
- **速率限制**：单 IP 每分钟最多 20 次解析请求，内置防滥用。
- **流式视频代理**：`/api/download` 透传 `Range` 头，支持视频切片/预览。
- **响应式前端**：支持桌面 / 移动端，含深色模式、多语言、下载历史。

---

## 📦 支持平台

| 平台 | 平台标识 | 类型 | 说明 |
| --- | --- | --- | --- |
| TikTok | `tiktok` | 视频 / 图集 / 音乐 | 从 SSR 数据多路径提取 |
| 抖音 | `douyin` | 视频 / 图集 / 音乐 | 自注册 ttwid + iesdouyin 分享页 SSR 直出数据 |
| 快手 | `kuaishou` | 视频 / 图集 | 从移动端 H5 `INIT_STATE` 提取 |
| 小红书 | `xiaohongshu` | 视频 / 图文 | 从 `__INITIAL_STATE__` 提取 |
| 哔哩哔哩 | `bilibili` | 视频 | 公共 API + html5 免登录流（直连 412 时走住宅出口） |
| YouTube | `youtube` | 视频 | Innertube IOS 客户端直出视频轨 + 音频轨（无需 PO Token/签名解密） |
| Instagram | `instagram` | 视频 / 图片 | GraphQL + embed 双路（数据中心 IP 常被要求登录） |

> ⚠️ 抖音已改为分享页 SSR 路线；小红书裸 `explore/<id>` 链接通常需要分享文本里的 `xsec_token`；Instagram 在数据中心 IP 下可能被登录墙拦截。

---

## 🗂 项目结构

```
.
├── src/
│   └── index.ts              # Cloudflare Worker 主入口（所有解析器 + 路由）
├── public/
│   └── index.html            # 前端单页应用（公开访问，无需密码）
├── docs/
│   └── API.md                # 接口文档
├── wrangler.jsonc            # Worker 配置（资源目录 / 变量）
├── package.json              # 脚本与依赖
├── tsconfig.json             # TypeScript 配置
└── .gitignore
```

---

## 🚀 本地开发

**环境要求**：Node.js ≥ 18、npm，以及一个 [Cloudflare 账号](https://dash.cloudflare.com)。

```bash
# 1. 安装依赖
npm install

# 2. 本地运行（开发预览）
npm run dev

# 3. 指定远程 Worker 名或本地产生类型
npm run types
```

> 抖音的无头浏览器兜底依赖线上 `BROWSER` binding（Browser Rendering），本地 `wrangler dev` 无该 binding 时会自动降级为普通抓取。

---

## ☁️ 部署到 Cloudflare Workers

```bash
# 配置令牌与账号（或用 dashboard 交互登录）
export CLOUDFLARE_API_TOKEN=your_api_token
export CLOUDFLARE_ACCOUNT_ID=your_account_id

# 部署
npm run deploy
```

部署完成后访问 `https://<worker-name>.<account-id>.workers.dev` 即可直接使用，无需密码。

> 若需启用抖音的无头浏览器解析，请在 Cloudflare Dashboard 为该 Worker 开通 **Browser Rendering** 服务，`wrangler.jsonc` 中已预置 `browser.binding = "BROWSER"`。

---

## 📡 API 文档

### `POST /api/parse`

解析一条平台链接，返回无水印下载地址与元数据。

**请求头**

| 头 | 值 |
| --- | --- |
| `Content-Type` | `application/json` |

> 本接口为公开访问，无需携带 `Authorization`。

**请求体**

```json
{ "url": "https://www.douyin.com/video/123456789" }
```

**响应**

```json
{
  "success": true,
  "data": {
    "platform": "douyin",
    "type": "video",
    "author": "xxx",
    "authorId": "xxx",
    "avatar": "https://...",
    "desc": "视频标题",
    "cover": "https://...",
    "videoUrl": "https://.../video.mp4",
    "musicUrl": "https://.../audio.mp3",
    "duration": 12,
    "images": [],
    "playCount": 100,
    "diggCount": 10,
    "commentCount": 2,
    "shareCount": 1,
    "createTime": 1710000000
  }
}
```

### `GET /api/download`

代理下载解析出的媒体直链（处理平台防盗链）。

```
/api/download?url=<encoded_media_url>
```

支持 `Range` 头透传（视频切片）与 `?preview=1`（内联预览）。仅允许白名单媒体域名。

### `GET /api/health`

健康检查，返回服务状态与平台列表。

### `POST /mcp`（MCP 服务端）

遵循 MCP Streamable HTTP 传输（JSON-RPC 2.0），供 Claude、Cursor、Cherry Studio 等 MCP 客户端直接接入。

- 端点：`POST https://<你的域名>/mcp`
- 鉴权：`Authorization: Bearer <MCP_TOKEN>`（也支持 `?token=<MCP_TOKEN>`）
- 配置令牌：`wrangler secret put MCP_TOKEN`

暴露的工具：

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `parse_video` | `url: string` | 解析分享链接，返回作者、标题、封面、无水印直链、图集与统计 |
| `list_platforms` | — | 列出支持的平台及域名 |

调用示例：

```bash
curl -X POST https://<你的域名>/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"parse_video","arguments":{"url":"https://v.douyin.com/xxxx/"}}}'
```

客户端配置示例（Claude Desktop / Cursor 等支持远程 MCP 的客户端）：

```json
{
  "mcpServers": {
    "tiksaver": {
      "type": "http",
      "url": "https://<你的域名>/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

---

## 🧠 解析原理（简要）

各平台解析器尽量利用页面对公开爬取友好的嵌入式数据，避免计算签名：

- **抖音**：向 `ttwid.bytedance.com` 自注册 ttwid 后，带该 Cookie 抓取 `iesdouyin.com` 分享页，SSR 会直接内嵌 `_ROUTER_DATA.videoInfoRes.item_list`，无需签名、无头浏览器或住宅出口。浏览器渲染与 ESP32 出口仅作兜底。
- **哔哩哔哩**：调用官方公开接口 `x/web-interface/view` 获取 BV/CID，再用 `x/player/playurl` 的 html5 平台参数免登录拿到分段直链。
- **YouTube**：受签名加密限制，Worker 内只能获取元数据（oembed），直链下载需配合 `yt-dlp` 等外部工具。
- 下载代理会按平台补全 `Referer` 请求头，规避常见的防盗链 403。

> 提示：平台反爬策略动态变化，某些平台（尤其抖音）在数据中心/海外 IP 下可能被临时拦截。抖音已改为分享页 SSR 路线，失败时再降级到无头浏览器与住宅出口。

---

## 🔒 安全说明

- 本工具为**公开访问**，请勿在生产环境上传敏感信息；如需限流请调整 `RATE_LIMIT_MAX`。
- 代理下载仅放行白名单媒体域名，防止被滥用作通用代理。
- 抖音解析使用 Cloudflare 官方 Browser Rendering 服务，遵循其计费与使用条款。

---

## 📜 License

[MIT](./LICENSE)