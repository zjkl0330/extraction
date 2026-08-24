# API 接口文档

所有接口部署在 Cloudflare Worker 上。基础路径为 `https://<worker-name>.<account-id>.workers.dev`。

## 鉴权说明

本项目已移除访问鉴权，所有接口**公开访问**，无需携带 `Authorization` 头。

> 抖音解析内置 Cloudflare Browser Rendering 无头浏览器渲染兜底，提升数据中心/海外访问的成功率。

---

## POST /api/parse — 解析链接

解析平台链接并将无水印直链与元数据一并返回。

### 请求

```bash
curl -X POST "$WORKER/api/parse" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://v.douyin.com/xxxx/"}'
```

请求体字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 平台分享链接或口令（会自动提取其中 URL） |

### 成功响应 `200`

```json
{
  "success": true,
  "data": {
    "platform": "douyin",
    "type": "video",
    "author": "创作者昵称",
    "authorId": "创作者ID",
    "avatar": "https://.../avatar.jpg",
    "desc": "作品描述/标题",
    "cover": "https://.../cover.jpg",
    "videoUrl": "https://v3-dy.../video/tos-cn.../playback/...mp4",
    "musicUrl": "https://.../audio/music/...mp3",
    "duration": 15,
    "images": [],
    "playCount": 9999,
    "diggCount": 888,
    "commentCount": 66,
    "shareCount": 12,
    "downloadCount": 0,
    "createTime": 1710000000,
    "note": "可选提示文案"
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `platform` | 平台标识：`tiktok`/`douyin`/`kuaishou`/`xiaohongshu`/`bilibili`/`youtube`/`instagram` |
| `type` | `video` 或 `image`（图集时 `images` 非空且 `videoUrl` 为空） |
| `videoUrl` | 无水印视频直链（`youtube` 无该直链，仅有预览 page URL） |
| `images` | 图集所用到的图片直链列表 |
| `musicUrl` | 背景音乐直链（TikTok/抖音较常见，可为空） |
| `note` | 平台特定提示，如"B站高清需登录""YouTube 无法直链下载"等 |

### 错误响应

| HTTP | error | 说明 |
| --- | --- | --- |
| 400 | `INVALID_JSON` / `EMPTY_URL` / `NO_URL_FOUND` / `UNSUPPORTED_PLATFORM` | 参数问题 |
| 429 | `RATE_LIMITED` | 超过 20 次/分钟/IP |
| 502 | `PARSE_FAILED` | 平台解析失败，`message` 为友好提示，`detail` 为内部错误码 |

---

## GET /api/download — 代理下载

将解析出的媒体直链代理回源下载，规避平台防盗链（补全 `Referer`）。

### 请求

```
GET /api/download?url=<urlencoded_media_url>[&preview=1]
```

| 参数 | 说明 |
| --- | --- |
| `url` | 媒体直链（必须为目标平台的 CDN 域名，白名单校验） |
| `preview` | 传 `1` 时以 `inline` 方式返回便于浏览器预览，否则为 `attachment` 下载 |
| `Range` 头 | 透传到源站，支持视频切片 / 断点续传 |

### 白名单域名

代理仅放行下列域名，其余返回 `403 DOMAIN_NOT_ALLOWED`：

- TikTok/CDN：`tiktok.com` `tiktokcdn.com` `byteoversea.com` `ibyteimg.com` 等
- 抖音：`douyin.com` `douyinvod.com` `douyinpic.com` `pstatp.com` 等
- 快手：`kwimgs.com` `kwaicdn.com` `chenzhongtech.com`
- 小红书：`xiaohongshu.com` `xhscdn.com` `ci.xiaohongshu.com`
- B站：`bilivideo.com` `bilivideo.cn`
- Instagram：`fbcdn.net` `cdninstagram.com`

### 响应

`200`（或 `206 Partial Content`，若带 Range），透传回源 `Content-Type`、`Content-Length`、`Content-Range`，并设置 `Content-Disposition`.

---

## GET /api/health — 健康检查

无需鉴权。

```json
{
  "status": "ok",
  "timestamp": 1710000000,
  "service": "tiksaver",
  "platforms": ["tiktok", "douyin", "kuaishou", "xiaohongshu", "bilibili", "youtube", "instagram"]
}
```

---

## 内部错误码参考（`detail`）

解析失败时 `detail` 携带内部错误码，便于排查：

| 错误码 | 含义 |
| --- | --- |
| `DOUYIN_NO_VIDEO_ID` | 无法从链接提取视频 ID |
| `DOUYIN_NO_DATA` | 抖音分享页未返回数据 |
| `DOUYIN_BLOCKED` | 抖音反爬拦截（数据中心 IP） |
| `DOUYIN_NO_MEDIA` | 未提取到下载地址 |
| `DOUYIN_HTTP_xxx` | 抖音上游 HTTP 错误 |
| `KUAISHOU_NO_PHOTO_ID` | 快手链接缺少作品 ID |
| `KUAISHOU_NO_INIT_STATE` | 快手页面结构变化 |
| `XHS_NO_STATE` / `XHS_NO_NOTE` | 小红书页面无初始状态 |
| `BILI_NO_BVID` | B站链接缺少 BV/AV 号 |
| `BILI_API_ERROR` | B站 API 返回异常 |
| `YT_NO_VIDEO_ID` | YouTube 链接缺少视频 ID |
| `IG_NO_SHORTCODE` | Instagram 链接缺少 shortcode |
| `UNSUPPORTED_PLATFORM` | 未识别平台 |