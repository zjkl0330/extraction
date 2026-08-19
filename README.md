# Extraction

多平台短视频/图片无水印解析下载工具（Cloudflare Worker），支持 **TikTok、抖音、快手、小红书、哔哩哔哩、YouTube、Instagram** 共 7 大平台。基于 Cloudflare Workers + 静态资源部署，带访问鉴权（私人使用）、速率限制与平台级代理下载。

> 📌 本项目为**私人使用**工具，所有解析接口均需携带访问令牌（`ACCESS_TOKEN`）方可调用。

---

## ✨ 功能特性

- **多平台解析**：自动识别链接所属平台并调用对应解析器。
- **无水印下载**：优先返回去除平台水印的直链，交由服务端代理下载。
- **图片图集支持**：抖音 / TikTok / 快手 / 小红书 / Instagram 图集可批量下载。
- **视频 & 音乐**：TikTok / 抖音支持同时提取视频与背景音乐。
- **访问鉴权**：私有部署，`/api/parse` 需携带 `Authorization: Bearer <token>`。
- **速率限制**：单 IP 每分钟最多 20 次解析请求，内置防滥用。
- **流式视频代理**：`/api/download` 透传 `Range` 头，支持视频切片/预览。
- **响应式前端**：支持桌面 / 移动端，含深色模式、多语言、下载历史。

---

## 📦 支持平台

| 平台 | 平台标识 | 类型 | 说明 |
| --- | --- | --- | --- |
| TikTok | `tiktok` | 视频 / 图集 / 音乐 | 从 SSR 数据多路径提取 |
| 抖音 | `douyin` | 视频 / 图集 / 音乐 | 多域名分享页 + 直链拼接降级 |
| 快手 | `kuaishou` | 视频 / 图集 | 从移动端 H5 `INIT_STATE` 提取 |
| 小红书 | `xiaohongshu` | 视频 / 图文 | 从 `__INITIAL_STATE__` 提取 |
| 哔哩哔哩 | `bilibili` | 视频 | 公共 API + html5 免登录流 |
| YouTube | `youtube` | 视频（仅预览） | 签名加密，仅返回元数据 |
| Instagram | `instagram` | 视频 / 图片 | GraphQL API |

> ⚠️ 抖音对数据中心 IP 常有反爬（分享页返回空壳），本实现内置多域名 + 多提取方式降级，但仍受平台风控影响，失败时会给出明确提示。

---

## 🗂 项目结构

```
.
├── src/
│   └── index.ts              # Cloudflare Worker 主入口（所有解析器 + 路由）
├── public/
│   └── index.html            # 前端单页应用（密码门禁 + 主界面）
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

`ACCESS_TOKEN` 在 `wrangler.jsonc` 的 `vars` 中配置。本地开发时亦可用 `.dev.vars`（加入 `.gitignore`）覆盖。

```env
# .dev.vars
ACCESS_TOKEN=your-secret-token
```

---

## ☁️ 部署到 Cloudflare Workers

```bash
# 配置令牌与账号（或用 dashboard 交互登录）
export CLOUDFLARE_API_TOKEN=your_api_token
export CLOUDFLARE_ACCOUNT_ID=your_account_id

# 部署
npm run deploy
```

部署完成后访问 `https://<worker-name>.<account-id>.workers.dev`，会先进入访问密码页（密码即 `ACCESS_TOKEN`）。

**务必**：`wrangler.jsonc` 中的 `ACCESS_TOKEN` 请替换为你自己的强密码，勿使用仓库默认值。

---

## 📡 API 文档

### `POST /api/parse`

解析一条平台链接，返回无水印下载地址与元数据。

**请求头**

| 头 | 值 |
| --- | --- |
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <ACCESS_TOKEN>` |

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

---

## 🧠 解析原理（简要）

各平台解析器尽量利用页面对公开爬取友好的嵌入式数据，避免计算签名：

- **抖音 / TikTok / 快手 / 小红书**：抓取分享页 HTML，从 `_ROUTER_DATA` / `__INITIAL_STATE__` / `INIT_STATE` 等全局 JSON 中提取 `play_addr` 或图集地址。抖音会从 HTML 提取 `uri` 后拼接官方 `play` 接口拿到无水印直链。
- **哔哩哔哩**：调用官方公开接口 `x/web-interface/view` 获取 BV/CID，再用 `x/player/playurl` 的 html5 平台参数免登录拿到分段直链。
- **YouTube**：受签名加密限制，Worker 内只能获取元数据（oembed），直链下载需配合 `yt-dlp` 等外部工具。
- 下载代理会按平台补全 `Referer` 请求头，规避常见的防盗链 403。

> 提示：平台反爬策略动态变化，某些平台（尤其抖音）在数据中心/海外 IP 下可能被临时拦截。若解析失败，前端会给出明确的中文提示。

---

## 🔒 安全说明

- 本项目内置访问鉴权，仅供**私人 / 小范围**使用，请勿公开部署后分发密码。
- `ACCESS_TOKEN` 属于敏感配置，请勿提交到 Git 历史；本仓库已用 `.gitignore` 与占位符规避。
- 代理下载仅放行白名单媒体域名，防止被滥用作通用代理。

---

## 📜 License

[MIT](./LICENSE)