/**
 * TikSaver — 多平台视频下载器 (Cloudflare Worker)
 *
 * 支持平台：TikTok / 抖音 / 快手 / 小红书 / 哔哩哔哩 / YouTube / Instagram
 *
 * Routes:
 *   POST /api/parse        — 解析链接（公开访问）
 *   GET  /api/download     — 代理下载
 *   GET  /api/health       — 健康检查
 *   *                     — 静态资源
 */

import puppeteer from "@cloudflare/puppeteer";
import type { BrowserWorker } from "@cloudflare/puppeteer";

export interface Env {
  ASSETS: Fetcher;
  BROWSER?: BrowserWorker;
}

// ── 通用类型 ──────────────────────────────────────────

type Platform = "tiktok" | "douyin" | "kuaishou" | "xiaohongshu" | "bilibili" | "youtube" | "instagram";

interface ParsedResult {
  platform: Platform;
  type: "video" | "image";
  author: string;
  authorId: string;
  avatar: string;
  desc: string;
  cover: string;
  videoUrl: string;
  musicUrl: string;
  duration: number;
  images: string[];
  playCount: number;
  diggCount: number;
  commentCount: number;
  shareCount: number;
  downloadCount: number;
  createTime: number;
  note?: string; // 平台特定提示
}

// ── Helpers ────────────────────────────────────────────

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const PC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

/** 从用户输入文本中提取 URL */
function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"'\u3000-\u303F\uff00-\uffef]+/i);
  return match ? match[0] : null;
}

/** 检测平台 */
function detectPlatform(url: string): Platform | null {
  const u = url.toLowerCase();
  if (u.includes("tiktok.com") || u.includes("vm.tiktok.com") || u.includes("vt.tiktok.com")) return "tiktok";
  if (u.includes("douyin.com") || u.includes("iesdouyin.com") || u.includes("v.douyin.com")) return "douyin";
  if (u.includes("kuaishou.com") || u.includes("v.kuaishou.com") || u.includes("chenzhongtech.com") || u.includes("kwimgs.com")) return "kuaishou";
  if (u.includes("xiaohongshu.com") || u.includes("xhslink.com")) return "xiaohongshu";
  if (u.includes("bilibili.com") || u.includes("b23.tv")) return "bilibili";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("instagram.com")) return "instagram";
  return null;
}

/** 跟随重定向，返回最终 URL */
async function followRedirects(url: string, headers: Record<string, string>, maxRedirects = 5): Promise<string> {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    let res: Response;
    try {
      res = await fetch(currentUrl, { redirect: "manual", headers });
    } catch {
      // manual 模式失败时尝试 follow 模式
      try {
        res = await fetch(currentUrl, { redirect: "follow", headers });
        return res.url || currentUrl;
      } catch {
        break;
      }
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location") ?? res.headers.get("location");
      if (loc) {
        currentUrl = new URL(loc, currentUrl).href;
        // 读取并丢弃 body 以释放连接
        try { await res.text(); } catch { /* ignore */ }
        continue;
      }
    }
    // 读取并丢弃 body
    try { await res.text(); } catch { /* ignore */ }
    break;
  }
  return currentUrl;
}

/** 从文本中提取 JSON 对象（平衡花括号匹配） */
function extractJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

/** 访问令牌验证（已弃用：本项目改为公开访问，移除密码） */

// ── 速率限制 ──────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 20;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

let lastCleanup = Date.now();
function cleanupRateLimit(): void {
  const now = Date.now();
  if (now - lastCleanup < 5 * 60_000) return;
  lastCleanup = now;
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}

// ═══════════════════════════════════════════════════════════
//  平台解析器
// ═══════════════════════════════════════════════════════════

// ── TikTok ────────────────────────────────────────────

async function parseTikTok(rawUrl: string): Promise<ParsedResult> {
  const response = await fetch(rawUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": PC_UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();

  const extractors = [extractTikTokUniversal, extractTikTokSigi, extractTikTokNext];
  for (const fn of extractors) {
    const result = fn(html);
    if (result) return { ...result, platform: "tiktok" };
  }
  throw new Error("PARSE_FAILED");
}

function extractTikTokUniversal(html: string): Omit<ParsedResult, "platform"> | null {
  const marker = '"__UNIVERSAL_DATA_FOR_REHYDRATION__"';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const tagStart = html.lastIndexOf("<script", idx);
  const cStart = html.indexOf(">", tagStart) + 1;
  const cEnd = html.indexOf("</script>", cStart);
  if (cStart === 0 || cEnd === -1) return null;
  let data: any;
  try { data = JSON.parse(html.slice(cStart, cEnd).trim()); } catch { return null; }
  const scope = data?.["__DEFAULT_SCOPE__"] ?? {};
  const detail = scope?.["webapp.video-detail"] ?? scope?.["webapp.aweme.detail"];
  const item = detail?.["itemInfo"]?.["itemStruct"] ?? detail?.["itemStruct"];
  if (!item) return null;
  return mapTikTokItem(item);
}

function extractTikTokSigi(html: string): Omit<ParsedResult, "platform"> | null {
  const marker = "window['SIGI_STATE']";
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jStart = html.indexOf("=", start) + 2;
  const jEnd = html.indexOf("</script>", jStart);
  if (jEnd === -1) return null;
  let data: any;
  try { data = JSON.parse(html.slice(jStart, jEnd).trim().replace(/;?\s*$/, "")); } catch { return null; }
  const mod = data?.["ItemModule"] ?? {};
  const ids = Object.keys(mod);
  if (ids.length === 0) return null;
  return mapTikTokItem(mod[ids[0]]);
}

function extractTikTokNext(html: string): Omit<ParsedResult, "platform"> | null {
  const idx = html.indexOf('"__NEXT_DATA__"');
  if (idx === -1) return null;
  const tagStart = html.lastIndexOf("<script", idx);
  if (tagStart === -1) return null;
  const cStart = html.indexOf(">", tagStart) + 1;
  const cEnd = html.indexOf("</script>", cStart);
  if (cStart === 0 || cEnd === -1) return null;
  let data: any;
  try { data = JSON.parse(html.slice(cStart, cEnd).trim()); } catch { return null; }
  const item = data?.props?.pageProps?.itemInfo?.itemStruct ?? data?.props?.pageProps?.itemStruct;
  if (!item) return null;
  return mapTikTokItem(item);
}

function mapTikTokItem(item: any): Omit<ParsedResult, "platform"> | null {
  if (!item) return null;
  const video = item.video ?? {};
  const music = item.music ?? {};
  const stats = item.stats ?? {};
  const author = item.author ?? {};
  const imageList = item.imagePost?.images ?? item.images;
  const isImage = Array.isArray(imageList) && imageList.length > 0 && !video.playAddr;

  let videoUrl = "";
  if (Array.isArray(video.playAddr)) videoUrl = video.playAddr[0] ?? "";
  else if (typeof video.playAddr === "string") videoUrl = video.playAddr;
  else if (Array.isArray(video.downloadAddr)) videoUrl = video.downloadAddr[0] ?? "";
  else if (typeof video.downloadAddr === "string") videoUrl = video.downloadAddr;

  let images: string[] = [];
  if (isImage && Array.isArray(imageList)) {
    images = imageList.map((img: any) => {
      if (typeof img === "string") return img;
      if (img?.url) return img.url;
      if (Array.isArray(img?.urlList)) return img.urlList[0] ?? "";
      if (Array.isArray(img?.displayImage?.urlList)) return img.displayImage.urlList[0] ?? "";
      return "";
    }).filter((u: string) => u.length > 0);
  }

  let cover = "";
  for (const c of [video.cover, video.originCover, video.dynamicCover]) {
    if (Array.isArray(c) && c[0]) { cover = c[0]; break; }
    if (typeof c === "string" && c) { cover = c; break; }
  }
  if (!cover && images.length > 0) cover = images[0];

  let avatar = "";
  const av = author.avatar ?? author.avatarThumb ?? author.avatarMedium;
  if (Array.isArray(av)) avatar = av[0] ?? "";
  else if (typeof av === "string") avatar = av;

  let musicUrl = "";
  if (typeof music.playUrl === "string") musicUrl = music.playUrl;
  else if (Array.isArray(music.playUrl)) musicUrl = music.playUrl[0] ?? "";

  if (!videoUrl && images.length === 0) return null;
  return {
    type: isImage ? "image" : "video", author: author.nickname ?? author.uniqueId ?? "Unknown",
    authorId: author.uniqueId ?? "", avatar, desc: item.desc ?? "", cover, videoUrl, musicUrl,
    duration: video.duration ?? 0, images, playCount: stats.playCount ?? 0, diggCount: stats.diggCount ?? 0,
    commentCount: stats.commentCount ?? 0, shareCount: stats.shareCount ?? 0,
    downloadCount: stats.downloadCount ?? 0, createTime: item.createTime ?? 0,
  };
}

// ── 抖音 (Douyin) ─────────────────────────────────────
//
// 兼容 2025-2026 抖音分享页结构。抖音对数据中心 IP 常返回"空壳页"，
// 因此这里采用多域名 + 多提取方式降级，尽量在未风控的网络下成功。
// 即使失败也会抛出明确的 DOUYIN_* 错误便于前端提示。

const DOUYIN_SHARE_HOSTS = [
  "https://www.iesdouyin.com",
  "https://m.douyin.com",
  "https://www.douyin.com",
];

/** 提取抖音视频 ID（/video/ /note/ /share/ 及重定向后查询参数） */
async function extractDouyinVideoId(rawUrl: string): Promise<string> {
  let videoId = "";

  // 短链接：跟随重定向取最终 URL
  if (rawUrl.includes("v.douyin.com") || rawUrl.includes("v.kuaishou.com")) {
    const finalUrl = await followRedirects(rawUrl, {
      "User-Agent": MOBILE_UA,
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    });
    const mV = finalUrl.match(/\/video\/(\d+)/);
    const mN = finalUrl.match(/\/note\/(\d+)/);
    const mA = finalUrl.match(/\/share\/(?:video|note)\/(\d+)/);
    if (mV?.[1] || mN?.[1] || mA?.[1]) return mV?.[1] ?? mN?.[1] ?? mA?.[1] ?? "";
    try {
      const u = new URL(finalUrl);
      videoId = u.searchParams.get("aweme_id") ?? u.searchParams.get("item_id") ?? "";
      if (videoId) return videoId;
    } catch { /* ignore */ }
  }

  // 长链接：直接从原始 URL 中提取
  const mV = rawUrl.match(/\/video\/(\d+)/);
  const mN = rawUrl.match(/\/note\/(\d+)/);
  const mA = rawUrl.match(/\/share\/(?:video|note)\/(\d+)/);
  videoId = mV?.[1] ?? mN?.[1] ?? mA?.[1] ?? "";

  if (!videoId) throw new Error("DOUYIN_NO_VIDEO_ID");
  return videoId;
}

/** 使用无头浏览器抓取抖音分享页（更接近真实用户，可绕过部分空壳限制） */
async function fetchDouyinWithBrowser(endpoint: BrowserWorker, videoId: string): Promise<{ host: string; html: string }> {
  const browser = await puppeteer.launch(endpoint, { keep_alive: 600000 });
  try {
    const page = await browser.newPage();
    const url = `https://www.iesdouyin.com/share/video/${videoId}/`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    const html = await page.content();
    return { host: "puppeteer", html };
  } finally {
    await browser.close();
  }
}

/** 抓取抖音分享页 HTML（多域名依次尝试） */
async function fetchDouyinShareHtml(videoId: string): Promise<{ host: string; html: string }> {
  let lastErr = "no host available";
  for (const base of DOUYIN_SHARE_HOSTS) {
    let html = "";
    const url = `${base}/share/video/${videoId}/`;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": MOBILE_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Referer": "https://www.douyin.com/",
          "Cache-Control": "no-cache",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "fetch failed";
      continue;
    }
    if (html.length >= 1000) return { host: base, html };
    lastErr = "empty shell page";
  }
  throw new Error(lastErr.includes("HTTP") ? `DOUYIN_HTTP_${lastErr.split(" ")[1]}` : "DOUYIN_NO_DATA");
}

/**
 * 从分享页 HTML 中解析出完整视频项（item）。
 * 依次尝试多种数据路径，兼容抖音多次结构改版。
 */
function parseDouyinData(html: string): { data: any; item: any } | null {
  // A. _ROUTER_DATA（平衡花括号提取 + 正则回退）
  let data: any = null;
  const ri = html.indexOf("_ROUTER_DATA");
  if (ri !== -1) {
    const eq = html.indexOf("=", ri);
    const brace = eq !== -1 ? html.indexOf("{", eq) : -1;
    if (brace !== -1) {
      const jsonStr = extractJsonObject(html, brace);
      if (jsonStr) { try { data = JSON.parse(jsonStr); } catch { data = null; } }
    }
  }
  if (!data) {
    const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*\})\s*[;\n]*\s*<\/script>/);
    if (m) { try { data = JSON.parse(m[1]); } catch { data = null; } }
  }

  // B. RENDER_DATA（URL 编码的 JSON）
  if (!data) {
    const rd = html.match(/<script[^>]*id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/);
    if (rd?.[1]) {
      try { data = JSON.parse(decodeURIComponent(rd[1])); } catch { data = null; }
    }
  }

  if (!data) return null;

  // 递归深度优先查找 item（item_list[0] 或 aweme_detail）
  const findItem = (obj: any, depth = 0): any => {
    if (!obj || depth > 6 || typeof obj !== "object") return null;
    if (Array.isArray(obj.item_list) && obj.item_list.length > 0) return obj.item_list[0];
    if (obj.aweme_detail) return obj.aweme_detail;
    for (const v of Object.values(obj)) {
      const f = findItem(v, depth + 1);
      if (f) return f;
    }
    return null;
  };

  const item = findItem(data);
  if (!item) return null;
  return { data, item };
}

/** 从 HTML 直接提取 play_addr.uri（作为 JSON 解析失败的最后兜底） */
function extractDouyinUriFromHtml(html: string): string {
  // 常见结构: "play_addr":{"uri":"v0200fg..."}
  const m1 = html.match(/"play_addr"\s*:\s*\{[^{}]*?"uri"\s*:\s*"([A-Za-z0-9_]+)"/);
  if (m1?.[1]) return m1[1];
  // video 对象下的 uri
  const m2 = html.match(/\\?"uri\\?"\s*:\s*\\?"(v0[0-9]{4}[A-Za-z0-9]+)\\?"/);
  if (m2?.[1]) return m2[1];
  return "";
}

/** 从 uri 构造抖音无水印播放地址 */
function buildDouyinPlayUrl(uri: string): string {
  return `https://www.douyin.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`;
}

async function parseDouyin(rawUrl: string, browser?: BrowserWorker): Promise<ParsedResult> {
  // Step 1: 提取视频 ID
  const videoId = await extractDouyinVideoId(rawUrl);

  // Step 2: 优先使用无头浏览器抓取（真实渲染，破解空壳），失败则降级到普通 fetch
  let html = "";
  let viaBrowser = false;
  if (browser) {
    try {
      const r = await fetchDouyinWithBrowser(browser, videoId);
      html = r.html;
      viaBrowser = true;
    } catch { /* 浏览器失败，降级 fetch */ }
  }
  if (!html) {
    const r = await fetchDouyinShareHtml(videoId);
    html = r.html;
  }

  // Step 3: 尝试解析完整数据
  let item: any = null;
  const parsed = parseDouyinData(html);
  if (parsed) item = parsed.item;

  // Step 4: 若拿不到 item，则尽力从 HTML 提取 uri 生成直链
  const uriFromHtml = item ? "" : extractDouyinUriFromHtml(html);

  const author = item?.author ?? {};
  const video = item?.video ?? {};
  const stats = item?.statistics ?? {};

  const images = Array.isArray(item?.images) ? item.images : [];
  const isImage = images.length > 0;

  // 视频地址优先级：
  // 1. item.video.play_addr.url_list -> playwm 替换 play
  // 2. item.video.play_addr.uri -> 拼接 play 接口
  // 3. HTML 中直接提取的 uri -> 拼接 play 接口
  let videoUrl = "";
  const playAddr = video.play_addr ?? {};

  if (Array.isArray(playAddr.url_list) && playAddr.url_list.length > 0) {
    let u = playAddr.url_list[0];
    if (u.includes("playwm")) u = u.replace("playwm", "play");
    videoUrl = u;
  }
  if (!videoUrl) {
    const uri = playAddr.uri ?? "";
    if (uri && !uri.includes("mp3")) videoUrl = buildDouyinPlayUrl(uri);
  }
  if (!videoUrl && uriFromHtml) videoUrl = buildDouyinPlayUrl(uriFromHtml);
  if (!videoUrl) {
    const dl = video.download_addr ?? {};
    if (Array.isArray(dl.url_list) && dl.url_list.length > 0) {
      let u = dl.url_list[0];
      if (u.includes("playwm")) u = u.replace("playwm", "play");
      videoUrl = u;
    }
  }

  if (!videoUrl && !isImage) throw new Error(item ? "DOUYIN_NO_MEDIA" : "DOUYIN_BLOCKED");

  // 图集图片
  let imageUrls: string[] = [];
  if (isImage) {
    imageUrls = images.map((img: any) => {
      if (typeof img === "string") return img;
      const urls = img?.url_list ?? img?.urlList ?? [];
      return urls[0] ?? (img?.url ?? "");
    }).filter((u: string) => u.length > 0);
  }

  const coverUrls = video.cover?.url_list ?? video.origin_cover?.url_list ?? [];
  let cover = coverUrls[0] ?? "";
  if (!cover && imageUrls.length > 0) cover = imageUrls[0];

  const avatarUrls = author.avatar_thumb?.url_list ?? author.avatar_medium?.url_list ?? [];
  const avatar = avatarUrls[0] ?? "";

  const musicUrls = item?.music?.play_url?.url_list ?? item?.music?.play_url?.urlList ?? [];
  const musicUrl = Array.isArray(musicUrls) && musicUrls.length > 0 ? musicUrls[0] : "";

  return {
    platform: "douyin",
    type: isImage ? "image" : "video",
    author: author.nickname ?? "Unknown",
    authorId: author.unique_id ?? author.short_id ?? "",
    avatar,
    desc: item?.desc ?? "",
    cover,
    videoUrl,
    musicUrl,
    duration: video.duration ?? 0,
    images: imageUrls,
    playCount: stats.play_count ?? 0,
    diggCount: stats.digg_count ?? 0,
    commentCount: stats.comment_count ?? 0,
    shareCount: stats.share_count ?? 0,
    downloadCount: 0,
    createTime: item?.create_time ?? 0,
    note: item ? undefined : (viaBrowser ? "抖音端在浏览器渲染后仍未返回完整数据，可能是平台风控，请稍后重试" : "抖音当前可能对数据中心网络有限制，若解析失败请稍后重试或更换网络"),
  };
}

// ── 快手 (Kuaishou) ───────────────────────────────────

async function parseKuaishou(rawUrl: string): Promise<ParsedResult> {
  // 跟随短链接获取 photoId
  let photoId = "";
  if (rawUrl.includes("v.kuaishou.com") || rawUrl.includes("chenzhongtech.com")) {
    const finalUrl = await followRedirects(rawUrl, { "User-Agent": IPHONE_UA });
    const m = finalUrl.match(/\/(?:fw\/photo|short-video|video)\/([a-zA-Z0-9]+)/);
    if (m) photoId = m[1];
  } else {
    const m = rawUrl.match(/\/(?:short-video|video)\/([a-zA-Z0-9]+)/);
    if (m) photoId = m[1];
  }

  if (!photoId) throw new Error("KUAISHOU_NO_PHOTO_ID");

  // 请求移动端 H5 页面
  const h5Url = `https://c.kuaishou.com/fw/photo/${photoId}`;
  const res = await fetch(h5Url, {
    headers: {
      "User-Agent": IPHONE_UA,
      Referer: "https://www.kuaishou.com/",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // 提取 INIT_STATE
  const m = html.match(/window\.INIT_STATE\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) throw new Error("KUAISHOU_NO_INIT_STATE");

  let data: any;
  try { data = JSON.parse(m[1]); } catch { throw new Error("KUAISHOU_PARSE_ERROR"); }

  // 查找包含 photo 或 atlas 的键
  const key = Object.keys(data).find(k => data[k]?.photo || data[k]?.atlas);
  if (!key) throw new Error("KUAISHOU_NO_DATA");

  const entry = data[key];
  const photo = entry.photo;
  const atlas = entry.atlas;

  if (photo) {
    // 视频类型
    const mainMvUrls = photo.mainMvUrls ?? [];
    const videoUrl = mainMvUrls[0]?.url ?? "";
    const coverUrls = photo.coverUrls ?? [];
    const cover = coverUrls[0]?.url ?? "";
    const headUrls = photo.headUrls ?? [];

    return {
      platform: "kuaishou",
      type: "video",
      author: photo.userName ?? "Unknown",
      authorId: photo.userId ?? "",
      avatar: headUrls[0]?.url ?? "",
      desc: photo.caption ?? "",
      cover,
      videoUrl,
      musicUrl: "",
      duration: photo.duration ?? 0,
      images: [],
      playCount: photo.viewCount ?? 0,
      diggCount: photo.likeCount ?? 0,
      commentCount: photo.commentCount ?? 0,
      shareCount: photo.shareCount ?? 0,
      downloadCount: 0,
      createTime: photo.timestamp ?? 0,
    };
  }

  if (atlas) {
    // 图集类型
    const cdn = atlas.cdn ?? [];
    const cdnPrefix = cdn[0] ?? "";
    const list = atlas.list ?? [];
    const images = list.map((p: string) => `https://${cdnPrefix}${p}`);

    const coverUrls = entry.photo?.coverUrls ?? [];
    const headUrls = entry.photo?.headUrls ?? [];

    return {
      platform: "kuaishou",
      type: "image",
      author: entry.photo?.userName ?? "Unknown",
      authorId: entry.photo?.userId ?? "",
      avatar: headUrls[0]?.url ?? "",
      desc: entry.photo?.caption ?? "",
      cover: coverUrls[0]?.url ?? (images[0] ?? ""),
      videoUrl: "",
      musicUrl: "",
      duration: 0,
      images,
      playCount: 0,
      diggCount: entry.photo?.likeCount ?? 0,
      commentCount: entry.photo?.commentCount ?? 0,
      shareCount: entry.photo?.shareCount ?? 0,
      downloadCount: 0,
      createTime: entry.photo?.timestamp ?? 0,
    };
  }

  throw new Error("KUAISHOU_NO_MEDIA");
}

// ── 小红书 (Xiaohongshu) ──────────────────────────────

async function parseXiaohongshu(rawUrl: string): Promise<ParsedResult> {
  // 跟随短链接重定向
  let finalUrl = rawUrl;
  if (rawUrl.includes("xhslink.com")) {
    finalUrl = await followRedirects(rawUrl, { "User-Agent": IPHONE_UA });
  }

  const res = await fetch(finalUrl, {
    headers: {
      "User-Agent": PC_UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // 提取 __INITIAL_STATE__
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) throw new Error("XHS_NO_STATE");

  // 替换裸 undefined
  const jsonStr = m[1].replace(/\bundefined\b/g, "null");
  let data: any;
  try { data = JSON.parse(jsonStr); } catch { throw new Error("XHS_PARSE_ERROR"); }

  const noteMap = data?.note?.noteDetailMap;
  if (!noteMap) throw new Error("XHS_NO_NOTE");

  const noteId = Object.keys(noteMap)[0];
  const note = noteMap[noteId]?.note;
  if (!note) throw new Error("XHS_NO_NOTE_DATA");

  const user = note.user ?? {};
  const interact = note.interactInfo ?? {};
  const type = note.type ?? "normal";

  // 图片列表（去水印）
  let images: string[] = [];
  if (type === "normal" && Array.isArray(note.imageList)) {
    images = note.imageList.map((img: any) => {
      const traceId = img?.traceId;
      if (traceId) return `https://ci.xiaohongshu.com/${traceId}?imageView2/2/format/png`;
      return img?.urlDefault ?? img?.url ?? "";
    }).filter((u: string) => u.length > 0);
  }

  // 视频
  let videoUrl = "";
  let cover = "";
  let duration = 0;
  if (type === "video") {
    const stream = note.video?.media?.stream ?? {};
    const h264 = stream.h264 ?? [];
    const h265 = stream.h265 ?? [];
    videoUrl = h264[0]?.masterUrl ?? h265[0]?.masterUrl ?? "";
    cover = note.video?.cover?.url ?? "";
    duration = note.video?.media?.duration ?? 0;
  }

  if (type === "normal" && images.length === 0 && note.imageList) {
    images = note.imageList.map((img: any) => img?.urlDefault ?? img?.url ?? "").filter((u: string) => u.length > 0);
  }
  if (!cover && images.length > 0) cover = images[0];

  if (!videoUrl && images.length === 0) throw new Error("XHS_NO_MEDIA");

  return {
    platform: "xiaohongshu",
    type: type === "video" ? "video" : "image",
    author: user.nickname ?? "Unknown",
    authorId: user.userId ?? "",
    avatar: user.avatar ?? "",
    desc: `${note.title ?? ""} ${note.desc ?? ""}`.trim(),
    cover,
    videoUrl,
    musicUrl: "",
    duration,
    images,
    playCount: 0,
    diggCount: parseInt(interact.likedCount ?? "0") || 0,
    commentCount: parseInt(interact.commentCount ?? "0") || 0,
    shareCount: parseInt(interact.shareCount ?? "0") || 0,
    downloadCount: parseInt(interact.collectedCount ?? "0") || 0,
    createTime: note.time ?? 0,
  };
}

// ── 哔哩哔哩 (Bilibili) ───────────────────────────────

async function parseBilibili(rawUrl: string): Promise<ParsedResult> {
  // 跟随 b23.tv 短链
  let finalUrl = rawUrl;
  if (rawUrl.includes("b23.tv")) {
    finalUrl = await followRedirects(rawUrl, { "User-Agent": PC_UA });
  }

  // 提取 BV 号
  const bvMatch = finalUrl.match(/\/video\/(BV[\w]+)/i);
  const avMatch = finalUrl.match(/\/video\/av(\d+)/i);
  const bvid = bvMatch?.[1] ?? "";

  if (!bvid && !avMatch) throw new Error("BILI_NO_BVID");

  // 获取视频信息
  const viewUrl = bvid
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
    : `https://api.bilibili.com/x/web-interface/view?aid=${avMatch![1]}`;

  const viewRes = await fetch(viewUrl, {
    headers: { "User-Agent": PC_UA, Referer: "https://www.bilibili.com/" },
  });
  if (!viewRes.ok) throw new Error(`HTTP ${viewRes.status}`);
  const viewData = await viewRes.json() as any;

  if (viewData.code !== 0 || !viewData.data) throw new Error("BILI_API_ERROR");

  const d = viewData.data;
  const aid = d.aid;
  const cid = d.cid;

  // 获取视频流 URL（使用 html5 平台，免登录）
  const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid || ""}&aid=${aid}&cid=${cid}&platform=html5&qn=32&try_look=1`;
  const playRes = await fetch(playUrl, {
    headers: { "User-Agent": PC_UA, Referer: "https://www.bilibili.com/" },
  });

  let videoUrl = "";
  if (playRes.ok) {
    const playData = await playRes.json() as any;
    if (playData.code === 0 && playData.data?.durl?.length > 0) {
      videoUrl = playData.data.durl[0].url ?? "";
    }
  }

  // 统计数据
  const stat = d.stat ?? {};

  return {
    platform: "bilibili",
    type: "video",
    author: d.owner?.name ?? "Unknown",
    authorId: String(d.owner?.mid ?? ""),
    avatar: d.owner?.face ?? "",
    desc: d.title ?? "",
    cover: d.pic ?? "",
    videoUrl,
    musicUrl: "",
    duration: d.duration ?? 0,
    images: [],
    playCount: stat.view ?? 0,
    diggCount: stat.like ?? 0,
    commentCount: stat.reply ?? 0,
    shareCount: stat.share ?? 0,
    downloadCount: stat.favorite ?? 0,
    createTime: d.pubdate ?? 0,
    note: videoUrl ? undefined : "B站视频流需要登录才能获取高清下载，当前仅提供预览",
  };
}

// ── YouTube ───────────────────────────────────────────

async function parseYouTube(rawUrl: string): Promise<ParsedResult> {
  // 提取 videoId
  let videoId = "";
  const patterns = [
    /youtube\.com\/watch\?v=([\w-]+)/,
    /youtu\.be\/([\w-]+)/,
    /youtube\.com\/shorts\/([\w-]+)/,
    /youtube\.com\/embed\/([\w-]+)/,
  ];
  for (const p of patterns) {
    const m = rawUrl.match(p);
    if (m) { videoId = m[1]; break; }
  }
  if (!videoId) throw new Error("YT_NO_VIDEO_ID");

  // 使用 oembed 获取元数据
  const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const res = await fetch(oembedUrl, { headers: { "User-Agent": PC_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as any;

  return {
    platform: "youtube",
    type: "video",
    author: data.author_name ?? "Unknown",
    authorId: data.author_url?.replace("https://www.youtube.com/", "") ?? "",
    avatar: "",
    desc: data.title ?? "",
    cover: data.thumbnail_url ?? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    musicUrl: "",
    duration: 0,
    images: [],
    playCount: 0,
    diggCount: 0,
    commentCount: 0,
    shareCount: 0,
    downloadCount: 0,
    createTime: 0,
    note: "YouTube 因签名加密机制，暂不支持直接下载。请使用 yt-dlp 等专业工具下载。",
  };
}

// ── Instagram ─────────────────────────────────────────

async function parseInstagram(rawUrl: string): Promise<ParsedResult> {
  // 提取 shortcode
  const m = rawUrl.match(/instagram\.com\/(?:[^/]+\/)?(?:reel|p|reels)\/([^/?]+)/);
  if (!m) throw new Error("IG_NO_SHORTCODE");
  const shortcode = m[1];

  // 使用 GraphQL API
  const graphqlUrl = "https://www.instagram.com/api/graphql";

  const res = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "User-Agent": PC_UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-IG-App-ID": "936619743392459",
      "X-FB-LSD": "",
      Referer: `https://www.instagram.com/p/${shortcode}/`,
    },
    body: `variables=${encodeURIComponent(JSON.stringify({ shortcode }))}&doc_id=10015901848480474`,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as any;

  const media = data?.data?.xdt_shortcode_media;
  if (!media) throw new Error("IG_NO_MEDIA");

  const owner = media.owner ?? {};
  const isVideo = media.is_video === true;
  const videoVersions = media.video_versions ?? [];
  const imageUrl = media.display_url ?? "";

  let videoUrl = "";
  if (isVideo && videoVersions.length > 0) {
    // 选最高画质
    const sorted = videoVersions.sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0));
    videoUrl = sorted[0]?.url ?? "";
  }

  if (!videoUrl && !imageUrl) throw new Error("IG_NO_MEDIA_URL");

  return {
    platform: "instagram",
    type: isVideo ? "video" : "image",
    author: owner.username ?? "Unknown",
    authorId: String(owner.id ?? ""),
    avatar: owner.profile_pic_url ?? "",
    desc: media.caption?.text ?? "",
    cover: imageUrl,
    videoUrl,
    musicUrl: "",
    duration: media.video_duration ?? 0,
    images: isVideo ? [] : [imageUrl],
    playCount: media.video_play_count ?? 0,
    diggCount: media.edge_media_preview_like?.count ?? 0,
    commentCount: media.edge_media_to_comment?.count ?? 0,
    shareCount: 0,
    downloadCount: 0,
    createTime: media.taken_at_timestamp ?? 0,
  };
}

// ── 平台分发 ──────────────────────────────────────────

async function parseUrl(url: string, browser?: BrowserWorker): Promise<ParsedResult> {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("UNSUPPORTED_PLATFORM");

  switch (platform) {
    case "tiktok": return parseTikTok(url);
    case "douyin": return parseDouyin(url, browser);
    case "kuaishou": return parseKuaishou(url);
    case "xiaohongshu": return parseXiaohongshu(url);
    case "bilibili": return parseBilibili(url);
    case "youtube": return parseYouTube(url);
    case "instagram": return parseInstagram(url);
    default: throw new Error("UNSUPPORTED_PLATFORM");
  }
}

// ── 代理下载 ──────────────────────────────────────────

const ALLOWED_DOWNLOAD_DOMAINS = [
  // TikTok
  "tiktok.com", "tiktokcdn.com", "tiktokv.com", "byteoversea.com",
  "ibyteimg.com", "muscdn.com", "byteimg.com", "bytestatic.com", "ipstatp.com", "snssdk.com",
  // 抖音
  "douyin.com", "iesdouyin.com", "douyinvod.com", "douyinpic.com", "pstatp.com", "bytecdn", "bytedns",
  // 快手
  "kwimgs.com", "kwaicdn.com", "chenzhongtech.com",
  // 小红书
  "xiaohongshu.com", "xhscdn.com", "ci.xiaohongshu.com",
  // B站
  "bilivideo.com", "bilivideo.cn", "akamaized.net",
  // Instagram
  "fbcdn.net", "cdninstagram.com",
];

async function proxyDownload(url: string, filename: string, contentType: string, referer: string | undefined, request: Request): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": PC_UA,
  };
  if (referer) headers["Referer"] = referer;

  // 支持 Range 请求（视频流式播放需要）
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) headers["Range"] = rangeHeader;

  const res = await fetch(url, { headers });

  if (!res.ok && res.status !== 206) {
    throw new Error(`Download HTTP ${res.status}`);
  }

  const respHeaders = new Headers();
  respHeaders.set("Content-Type", res.headers.get("Content-Type") ?? contentType);

  // 透传 Content-Length
  const cl = res.headers.get("Content-Length");
  if (cl) respHeaders.set("Content-Length", cl);

  // 透传 Content-Range（206 响应）
  const cr = res.headers.get("Content-Range");
  if (cr) respHeaders.set("Content-Range", cr);

  // 透传 Accept-Ranges
  respHeaders.set("Accept-Ranges", "bytes");

  // 判断是预览还是下载：preview=1 时使用 inline，否则 attachment
  const isPreview = new URL(request.url).searchParams.get("preview") === "1";
  if (isPreview) {
    respHeaders.set("Content-Disposition", `inline; filename="${filename}"`);
  } else {
    respHeaders.set("Content-Disposition", `attachment; filename="${filename}"`);
  }

  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Access-Control-Allow-Headers", "Range");
  respHeaders.set("Cache-Control", "public, max-age=3600");

  return new Response(res.body, { status: res.status, headers: respHeaders });
}

// ── Route Handlers ─────────────────────────────────────

async function handleParse(request: Request, env: Env): Promise<Response> {
  cleanupRateLimit();
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!checkRateLimit(ip)) {
    return json({ success: false, error: "RATE_LIMITED", message: "请求过于频繁，请稍后再试" }, 429);
  }

  let body: { url?: string };
  try { body = await request.json(); } catch {
    return json({ success: false, error: "INVALID_JSON", message: "请求体不是合法的 JSON" }, 400);
  }

  const rawInput = body.url ?? "";
  if (!rawInput.trim()) {
    return json({ success: false, error: "EMPTY_URL", message: "请输入链接" }, 400);
  }

  const url = extractUrl(rawInput);
  if (!url) {
    return json({ success: false, error: "NO_URL_FOUND", message: "未识别到有效的链接" }, 400);
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return json({ success: false, error: "UNSUPPORTED_PLATFORM", message: "不支持的平台，目前支持 TikTok、抖音、快手、小红书、B站、YouTube、Instagram" }, 400);
  }

  const platformNames: Record<string, string> = {
    tiktok: "TikTok", douyin: "抖音", kuaishou: "快手",
    xiaohongshu: "小红书", bilibili: "哔哩哔哩", youtube: "YouTube", instagram: "Instagram",
  };

  try {
    const result = await parseUrl(url, env.BROWSER);
    return json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "未知错误";
    let userMessage = `解析失败，请检查链接是否正确`;
    if (msg.includes("403") || msg.includes("HTTP_403")) userMessage = `${platformNames[platform]} 拒绝了请求，请稍后重试`;
    else if (msg.includes("404") || msg.includes("HTTP_404")) userMessage = "内容不存在或已被删除";
    else if (msg === "UNSUPPORTED_PLATFORM") userMessage = "不支持的平台";
    else if (msg === "DOUYIN_NO_VIDEO_ID") userMessage = "无法从抖音链接中提取视频ID，请确保复制完整的分享链接";
    else if (msg === "DOUYIN_BLOCKED") userMessage = "抖音检测到数据中心/异常网络访问，已拒绝解析。请稍后重试，或尝试更换网络";
    else if (msg === "DOUYIN_NO_DATA") userMessage = "抖音页面结构已更新，未返回视频数据，请稍后重试";
    else if (msg === "DOUYIN_NO_ITEM") userMessage = "抖音视频信息不存在或已被删除";
    else if (msg === "DOUYIN_NO_MEDIA") userMessage = "未能提取到抖音视频下载地址，请稍后重试";
    else if (msg.startsWith("DOUYIN_HTTP_")) userMessage = `抖音服务器返回错误 (${msg.replace("DOUYIN_HTTP_", "")})，请稍后重试`;
    else if (msg === "PARSE_FAILED" || msg.includes("PARSE_ERROR") || msg.includes("NO_INIT_STATE") || msg.includes("NO_STATE")) {
      userMessage = `无法解析此${platformNames[platform]}链接，平台可能已更新页面结构`;
    }
    return json({ success: false, error: "PARSE_FAILED", message: userMessage, detail: msg }, 502);
  }
}

async function handleDownload(request: Request, url: URL): Promise<Response> {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) return json({ success: false, error: "MISSING_URL", message: "缺少 url 参数" }, 400);

  let parsed: URL;
  try { parsed = new URL(targetUrl); } catch {
    return json({ success: false, error: "INVALID_URL", message: "无效的 URL" }, 400);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_DOWNLOAD_DOMAINS.some(d => hostname.includes(d))) {
    return json({ success: false, error: "DOMAIN_NOT_ALLOWED", message: "不允许的域名" }, 403);
  }

  // 根据平台设置 Referer
  let referer = "";
  if (hostname.includes("douyin") || hostname.includes("iesdouyin")) referer = "https://www.douyin.com/";
  else if (hostname.includes("kuaishou") || hostname.includes("kwimgs")) referer = "https://www.kuaishou.com/";
  else if (hostname.includes("xiaohongshu") || hostname.includes("xhscdn")) referer = "https://www.xiaohongshu.com/";
  else if (hostname.includes("bilivideo")) referer = "https://www.bilibili.com/";
  else if (hostname.includes("tiktok") || hostname.includes("byteoversea")) referer = "https://www.tiktok.com/";

  const path = parsed.pathname.toLowerCase();
  let filename = "download";
  let contentType = "application/octet-stream";
  if (path.endsWith(".mp4")) { filename += ".mp4"; contentType = "video/mp4"; }
  else if (path.endsWith(".mp3")) { filename += ".mp3"; contentType = "audio/mpeg"; }
  else if (path.endsWith(".jpg") || path.endsWith(".jpeg")) { filename += ".jpg"; contentType = "image/jpeg"; }
  else if (path.endsWith(".png")) { filename += ".png"; contentType = "image/png"; }
  else if (path.endsWith(".webp")) { filename += ".webp"; contentType = "image/webp"; }
  else filename += ".bin";

  try {
    return await proxyDownload(targetUrl, filename, contentType, referer, request);
  } catch (err) {
    const message = err instanceof Error ? err.message : "下载失败";
    return json({ success: false, error: "DOWNLOAD_FAILED", message }, 502);
  }
}

function handleHealth(): Response {
  return json({ status: "ok", timestamp: Date.now(), service: "tiksaver", platforms: ["tiktok", "douyin", "kuaishou", "xiaohongshu", "bilibili", "youtube", "instagram"] });
}

// ── Entry Point ────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (pathname === "/api/parse" && method === "POST") return handleParse(request, env);
    if (pathname === "/api/download" && method === "GET") return handleDownload(request, url);
    if (pathname === "/api/health" && method === "GET") return handleHealth();

    return env.ASSETS.fetch(request);
  },
};
