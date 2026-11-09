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
  DOUYIN_KV?: KVNamespace;
  RELAY_BASE?: string;
  RELAY_KEY?: string;
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

/** 从任意 URL 中提取抖音视频 ID（/video/ /note/ /share/ 及查询参数） */
function getDouyinVideoIdFromUrl(rawUrl: string): string {
  const mV = rawUrl.match(/\/video\/(\d+)/);
  const mN = rawUrl.match(/\/note\/(\d+)/);
  const mA = rawUrl.match(/\/share\/(?:video|note)\/(\d+)/);
  const id = mV?.[1] ?? mN?.[1] ?? mA?.[1] ?? "";
  if (id) return id;
  try {
    const u = new URL(rawUrl);
    return u.searchParams.get("aweme_id") ?? u.searchParams.get("item_id") ?? "";
  } catch { return ""; }
}

/** 通过普通 fetch 跟随短链接重定向，解析出视频 ID（无头浏览器不可用时的兜底） */
async function resolveDouyinVideoIdByFetch(rawUrl: string): Promise<string> {
  const direct = getDouyinVideoIdFromUrl(rawUrl);
  if (direct) return direct;
  const finalUrl = await followRedirects(rawUrl, {
    "User-Agent": MOBILE_UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
  });
  const id = getDouyinVideoIdFromUrl(finalUrl);
  if (id) return id;
  throw new Error("DOUYIN_NO_VIDEO_ID");
}

/** 抓取抖音分享页 HTML（多域名依次尝试；带自注册 ttwid 可解锁 SSR 内嵌视频数据） */
async function fetchDouyinShareHtml(env: Env, videoId: string, type: "video" | "note" = "video"): Promise<{ host: string; html: string }> {
  let lastErr = "no host available";
  let ttwid = "";
  try { ttwid = await ensureTtwid(env); } catch { /* 无 ttwid 则拿到空壳，交给上层兜底 */ }
  for (const base of DOUYIN_SHARE_HOSTS) {
    let html = "";
    const url = `${base}/share/${type}/${videoId}/`;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": IPHONE_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Referer": "https://www.douyin.com/",
          ...(ttwid ? { "Cookie": `ttwid=${ttwid}` } : {}),
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

/** 从 HTML 中尝试直接抠出视频数据（含 _ROUTER_DATA / RENDER_DATA / 各类全局变量） */
function extractDouyinItemFromHtml(html: string): any | null {
  const parsed = parseDouyinData(html);
  if (parsed?.item) return parsed.item;

  // 兜底：从任意 <script> 内全局 JSON 深度查找带 play_addr 的对象
  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) ?? [];
  for (const s of scripts) {
    const m = s.match(/window\.(_ROUTER_DATA|RENDER_DATA|__INITIAL_STATE__|__NEXT_DATA__)\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
    if (!m) continue;
    let data: any;
    const raw = m[2].includes("RENDER_DATA") ? m[2] : m[2];
    try { data = JSON.parse(m[1] === "RENDER_DATA" ? decodeURIComponent((s.match(/>([\s\S]*?)<\/script>/) ?? ["",""])[1]?.trim() ?? "") : raw); } catch { continue; }
    if (!data) continue;
    const item = (() => {
      const walk = (o: any, d = 0): any => {
        if (!o || d > 6 || typeof o !== "object") return null;
        if (o.play_addr && (o.video || o.author)) return o;
        if (Array.isArray(o.item_list) && o.item_list[0]) return o.item_list[0];
        if (o.aweme_detail) return o.aweme_detail;
        for (const v of Object.values(o)) { const f = walk(v, d + 1); if (f) return f; }
        return null;
      };
      return walk(data);
    })();
    if (item) return item;
  }
  return null;
}

// ── 抖音：无头浏览器提取脚本（移植自 YunX DouyinParser，AGPL-3.0，2026-08 实测有效）──
//
// 核心认知（YunX + 本项目双重实测）：
// 1. 纯 HTTP 拿分享页已死：返回 byted_acrawler JS 挑战页/空壳页，无作品数据；
// 2. 真实浏览器跑完挑战后，页面会自己发 XHR 请求 aweme/v1/web/aweme/detail 拿详情——
//    这条响应才是干净的结构化数据（视频直链/图集/作者全在里面），必须文档开始前挂钩截获；
// 3. 兜底数据源：<script id="RENDER_DATA">（服务端直出的 URL 编码 JSON，app.videoDetail）。
//    图集的动图资源只有 SSR 这条路有（本服务暂不支持动图，忽略）。

/** 文档开始前注入：钩住 XHR + fetch，把页面自己发出的 aweme detail 响应原文存到 window.__dyDetailRaw */
const DOUYIN_HOOK_JS = `(function () {
  try {
    if (window.__dyHookInstalled) return;
    window.__dyHookInstalled = true;
    var save = function (url, text) {
      try {
        if (!text) return;
        if (String(url).indexOf('aweme/v1/web/aweme/detail') < 0) return;
        window.__dyDetailRaw = text;
      } catch (e) {}
    };
    // XHR 钩子（YunX 实测页面就是走 XHR 拿详情的）
    var rawOpen = XMLHttpRequest.prototype.open;
    var rawSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__dyUrl = String(url || ''); } catch (e) { this.__dyUrl = ''; }
      return rawOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      try {
        xhr.addEventListener('load', function () {
          try {
            if (xhr.status !== 200) return;
            // responseType 为 json 时读 responseText 会抛 InvalidStateError，必须双路兜底
            var text = '';
            try { text = xhr.responseText || ''; } catch (e) { text = ''; }
            if (!text) {
              try { var r = xhr.response; if (r) text = (typeof r === 'string') ? r : JSON.stringify(r); } catch (e) {}
            }
            save(xhr.__dyUrl || '', text);
          } catch (e) {}
        });
      } catch (e) {}
      return rawSend.apply(this, arguments);
    };
    // fetch 钩子（万一页面改版改用 fetch）
    var rawFetch = window.fetch;
    if (typeof rawFetch === 'function') {
      window.fetch = function () {
        var url = '';
        try { url = String((arguments[0] && arguments[0].url) || arguments[0] || ''); } catch (e) {}
        return rawFetch.apply(this, arguments).then(function (res) {
          try {
            var cloned = res.clone();
            cloned.text().then(function (t) { save(url, t); }).catch(function () {});
          } catch (e) {}
          return res;
        });
      };
    }
  } catch (e) {}
})()`;

/** 就绪判断：XHR 钩子拿到详情 或 DOM 出现真正的作品图（排除封面与「相关推荐」） */
const DOUYIN_READY_JS = `(function () {
  var raw = window.__dyDetailRaw;
  if (typeof raw === 'string' && raw.length > 0) return true;
  var imgs = document.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) {
    var s = imgs[i].src || '';
    if (!s || s.indexOf('douyinpic.com') < 0) continue;
    if (s.indexOf('WEBPC_RELATED') >= 0) continue;
    if (s.indexOf('biz_tag=aweme_images') >= 0 || s.indexOf('tplv-dy-aweme-images') >= 0) return true;
  }
  return false;
})()`;

/** 取数脚本：XHR 钩子详情优先，SSR #RENDER_DATA 兜底，DOM 作品图最后兜底 */
const DOUYIN_EXTRACT_JS = `(function () {
  try {
    function firstUrl(node) {
      if (!node) return '';
      var list = node.url_list || node.urlList || null;
      if (list && list.length) return String(list[0] || '');
      return '';
    }
    function hookDetail() {
      var raw = window.__dyDetailRaw || '';
      if (!raw) return null;
      try {
        var root = JSON.parse(raw);
        return root.aweme_detail || root.awemeDetail || (root.data && root.data.aweme_detail) || null;
      } catch (e) { return null; }
    }
    function readSsrDetail() {
      var node = document.querySelector('#RENDER_DATA');
      if (node && node.textContent) {
        try {
          var app = JSON.parse(decodeURIComponent(node.textContent)).app;
          if (app && app.videoDetail) return app.videoDetail;
        } catch (e) {}
      }
      try {
        var ssr = window.SSR_RENDER_DATA;
        if (ssr && ssr.app && ssr.app.videoDetail) return ssr.app.videoDetail;
      } catch (e) {}
      return null;
    }
    function imagesFrom(node) {
      if (!node || !node.length) return null;
      var list = [];
      for (var i = 0; i < node.length; i++) {
        var item = node[i];
        var u = firstUrl(item);
        if (!u && item.display_image) u = firstUrl(item.display_image);
        if (!u && item.owner_watermark_image) u = firstUrl(item.owner_watermark_image);
        if (u) list.push(u);
      }
      return list.length ? list : null;
    }
    function domWorkImages() {
      var result = [];
      var all = document.querySelectorAll('img');
      for (var i = 0; i < all.length; i++) {
        var src = all[i].src || '';
        if (src.indexOf('douyinpic') < 0) continue;
        if (src.indexOf('WEBPC_RELATED') >= 0) continue;
        var isWork = src.indexOf('biz_tag=aweme_images') >= 0 || src.indexOf('tplv-dy-aweme-images') >= 0;
        if (isWork && result.indexOf(src) < 0) result.push(src);
      }
      return result;
    }

    var hooked = hookDetail();
    var ssr = readSsrDetail();

    // 图集：SSR 优先（数据最全），钩子次之，DOM 最后兜底
    var images = imagesFrom(ssr && ssr.images) || imagesFrom(hooked && hooked.images)
        || imagesFrom(hooked && hooked.image_post_info && hooked.image_post_info.images) || domWorkImages();

    // 视频直链：钩子优先，SSR 兜底；playwm 换 play 去水印；bit_rate 多码率兜底
    var v = (hooked && hooked.video) || (ssr && ssr.video) || null;
    var video = '';
    if (v) {
      video = firstUrl(v.play_addr) || firstUrl(v.playAddr) || firstUrl(v.play_addr_h264);
      if (!video && v.bit_rate && v.bit_rate.length) {
        for (var i = 0; i < v.bit_rate.length; i++) {
          var c = firstUrl(v.bit_rate[i].play_addr);
          if (c) { video = c; break; }
        }
      }
      video = video.replace('/playwm/', '/play/');
    }

    var d = hooked || ssr;
    var author = '';
    if (d && d.author) author = d.author.nickname || d.author.unique_id || '';
    if (!author && d && d.authorInfo) author = d.authorInfo.nickname || d.authorInfo.nickName || '';
    var title = (d && d.desc) || '';
    if (!title) {
      var pageTitle = document.title || '';
      var tail = pageTitle.lastIndexOf(' - 抖音');
      if (tail > 0) pageTitle = pageTitle.substring(0, tail);
      title = pageTitle;
    }

    return {
      title: title,
      desc: (d && d.desc) || '',
      author: author,
      video: video,
      images: images || [],
      cover: (v && (firstUrl(v.cover) || firstUrl(v.cover_origin) || firstUrl(v.origin_cover))) || '',
      src: hooked ? 'hook' : (ssr ? 'ssr' : 'none')
    };
  } catch (e) {
    return { error: 'js: ' + e };
  }
})()`;

/**
 * 使用无头浏览器抓取抖音内容（YunX 路线）：
 * 桌面 UA 打开 www.douyin.com/{video|note}/{id}（分享域只是 302 到这里），
 * 文档开始前挂 XHR/fetch 钩子截获页面自己的 detail 响应，轮询就绪后提取小对象。
 * 冷启动约 25s（acrawler 挑战→重载→挂载→自发详情请求），所以超时给足 40s。
 */
async function fetchDouyinViaBrowser(browser: BrowserWorker, videoId: string, isShortLink: string): Promise<{ finalUrl: string; html: string; item: any } | null> {
  let launched: any = null;
  try {
    launched = await puppeteer.launch(browser, { keep_alive: 600000 });
    const page = await launched.newPage();
    await page.setUserAgent(PC_UA);
    await page.setViewport({ width: 1920, height: 1080 });
    // 钩子必须在文档开始前挂上，页面自己的详情请求发出去之前生效
    await page.evaluateOnNewDocument(DOUYIN_HOOK_JS);

    const target = isShortLink || `https://www.douyin.com/${videoId.includes("note") ? "note" : "video"}/${videoId}`;
    let finalUrl = "";
    let html = "";
    try {
      // domcontentloaded 即可：networkidle2 会因页面持续发请求而卡超时；就绪由 waitForFunction 轮询
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
      finalUrl = page.url();
      // 就绪轮询：钩子详情或 DOM 作品图出现（最多 40s，冷启动实测约 25s）
      await page.waitForFunction(DOUYIN_READY_JS, { polling: 1000, timeout: 40000 }).catch(() => {});
      const payload: any = await page.evaluate(DOUYIN_EXTRACT_JS).catch(() => null);
      if (payload && !payload.error && (payload.video || (Array.isArray(payload.images) && payload.images.length))) {
        // 映射成与分享页 item 同构的对象，下游解析逻辑完全复用
        const item: any = {
          desc: payload.desc || payload.title || "",
          author: { nickname: payload.author || "" },
        };
        if (payload.video) {
          item.video = { play_addr: { url_list: [payload.video] } };
          if (payload.cover) item.video.cover = { url_list: [payload.cover] };
        }
        if (Array.isArray(payload.images) && payload.images.length) {
          item.images = payload.images.map((u: string) => ({ url_list: [u] }));
          if (!payload.cover && payload.images[0]) item.video = item.video ?? {};
        }
        html = await page.content().catch(() => "");
        return { finalUrl, html, item };
      }
      html = await page.content().catch(() => "");
    } catch { /* 走 fetch 兜底 */ }
    if (!html && !finalUrl) return null;
    return { finalUrl, html, item: null };
  } finally {
    if (launched) await launched.close();
  }
}

// ── 抖音：住宅出口路线（ESP32 relay + 真浏览器引导 Cookie）──────────────
//
// 原理链（YunX + SegmentFault 逆向文双重印证）：
// 1. 分享页 SSR 数据被 __ac_nonce/__ac_signature Cookie 对把门；纯 HTTP 拿到的是挑战页或无数据空壳
// 2. __ac_signature 由页面内联的 72KB jsvmp（byted_acrawler）用 nonce 算出，且环境指纹烤进签名——
//    手动补环境生成的签名过不了服务端检测，真浏览器生成的才有效
// 3. 因此用 Browser Rendering（真 Chrome）引导一次：预埋自己生成的 nonce，挑战 JS 自动算出对应该
//    nonce 的有效签名，钩住 document.cookie 捕获，连同 ttwid 一起存 KV（7 天）
// 4. 之后所有解析请求都走 ESP32 住宅出口带上这对 Cookie，从家里 WiFi 拿到带数据的 SSR 页
// 5. Cookie 失效（响应退化成空壳）时自动重新引导一次

/** 生成 __ac_nonce：首字符 0 + 时间戳 hex + 随机 hex，总长 21（对齐真实样本格式） */
function genDouyinNonce(): string {
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  let rand = "";
  for (let i = 0; i < 11; i++) rand += Math.floor(Math.random() * 16).toString(16);
  return "0" + ts + rand;
}

/** 通过 ESP32 住宅出口抓一个网页，返回原始响应体 */
async function relayFetch(env: Env, url: string, headers: Record<string, string>, maxBytes = 900000): Promise<string> {
  const res = await fetch(`${env.RELAY_BASE}/api/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RELAY_KEY}` },
    body: JSON.stringify({ url, headers, maxBytes }),
  });
  if (!res.ok) throw new Error("RELAY_HTTP_" + res.status);
  return await res.text();
}

/**
 * 用真 Chrome（Browser Rendering）引导一次，拿到有效的 __ac_nonce + __ac_signature (+ ttwid)：
 * evaluateOnNewDocument 在页面脚本前预埋自己的 nonce（缺省时挑战 JS 会用它算签名），
 * 并钩住 document.cookie 捕获挑战 JS 写回的 __ac_signature。UA 必须与 relay 请求一致。
 */
async function bootstrapDouyinCookie(env: Env, videoId?: string): Promise<{ nonce: string; signature: string; ttwid: string; full: string }> {
  let launched: any = null;
  try {
    launched = await puppeteer.launch(env.BROWSER!, { keep_alive: 600000 });
    const page = await launched.newPage();
    await page.setUserAgent(PC_UA);
    const hookJs = `(function(){ try {
      try {
        var desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
        Object.defineProperty(document, 'cookie', {
          get: function(){ return desc.get.call(document); },
          set: function(v){ try { if (String(v).indexOf('__ac_signature=') >= 0) window.__acSig = String(v); } catch(e){} return desc.set.call(document, v); },
          configurable: true
        });
      } catch(e2) { window.__acErr = 'hook:' + e2; }
    } catch(e) { window.__acErr = 'seed:' + e; } })()`;
    await page.evaluateOnNewDocument(hookJs);
    // 捕获页面自己发出的详情 API 请求（含完整签名参数 + uifid 头），供住宅出口回放
    let realUrl = "";
    let uifid = "";
    page.on("request", (r: any) => {
      try {
        const u: string = r.url();
        if (!realUrl && /aweme\/v1\/web\/aweme\/detail\/?\?/.test(u)) {
          realUrl = u;
          const hd = r.headers?.() ?? {};
          uifid = String(hd["uifid"] ?? hd["UiFid"] ?? hd["UIFID"] ?? "");
        }
      } catch { /* ignore */ }
    });
    // 挑战页（byted_acrawler）只出现在 www.douyin.com/{video,note}/<id> 桌面路径；
    // 真浏览器过挑战 → 胶水脚本写 __ac_signature → 自动 reload
    const target = videoId ? `https://www.douyin.com/video/${videoId}` : "https://www.douyin.com/";
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    // 轮询等待签名写回（挑战 + reload 冷启动可能 20-40s）
    let sig = "";
    let finalCk = "";
    let sigSeenAt = -1;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const probe: any = await page
        .evaluate(`({ sig: window.__acSig || '', ck: document.cookie, err: window.__acErr || '' })`)
        .catch(() => ({ sig: "", ck: "", err: "eval-fail" }));
      finalCk = probe.ck || "";
      sig = probe.sig || "";
      if (/__ac_signature=/.test(finalCk)) {
        // 签名出现后不立即返回：继续等 reload 完成 + ttwid/其余 Cookie 写回（最多再等 12s）
        if (sigSeenAt < 0) sigSeenAt = i;
        if (/ttwid=/.test(finalCk) || i - sigSeenAt >= 6) break;
      }
      // 页面已发出带 x-secsdk-web-signature 的详情请求 → 立即收工（该签名 TTL 极短，必须秒级回放）
      if (realUrl && /__ac_signature=/.test(finalCk)) { console.log("bootstrap: realUrl captured, early exit"); break; }
    }
    console.log("bootstrap diag:", JSON.stringify({ url: page.url(), ckLen: finalCk.length, sigLen: sig.length }).slice(0, 400));
    // realUrl 未捕获时补等（页面发详情请求有延迟）；拿到后立刻收工保证签名新鲜
    for (let i = 0; i < 4 && !realUrl; i++) await new Promise((r) => setTimeout(r, 2000));
    const sigMatch = /__ac_signature=([^;]+)/.exec((sig || "") + ";" + (finalCk || ""));
    // nonce 以 Cookie 罐里的最终值为准（必须是服务端 Set-Cookie 签发的，来源可信）
    const nonceMatch = /__ac_nonce=([^;]+)/.exec(finalCk || "");
    if (!nonceMatch) throw new Error("BOOTSTRAP_NO_NONCE " + finalCk.slice(0, 120));
    if (!sigMatch) throw new Error("BOOTSTRAP_NO_SIG " + finalCk.slice(0, 120));
    // msToken：优先等页面 SDK 写回的；等不到就用随机 116 位（a_bogus 对同一字符串计算即可自洽）
    let msToken = "";
    if (!realUrl) {
      for (let i = 0; i < 5; i++) {
        const jar0: any[] = await page.cookies("https://www.douyin.com/").catch(() => []);
        const mt = jar0.find((c) => c.name === "msToken");
        if (mt) { msToken = mt.value; break; }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!msToken) {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+";
      let s = "";
      for (let i = 0; i < 116; i++) s += chars[Math.floor(Math.random() * chars.length)];
      msToken = s;
    }
    // 完整 Cookie 罐（含 HttpOnly，如 ttwid）：整罐回放最接近真实浏览器指纹
    let full = "";
    let ttwid = "";
    try {
      const jar: any[] = await page.cookies("https://www.douyin.com/");
      full = jar.map((c) => `${c.name}=${c.value}`).join("; ");
      const t = jar.find((c) => c.name === "ttwid");
      if (t) ttwid = t.value;
    } catch { /* cookies() 失败则退回 parts */ }
    if (!ttwid) {
      const ttwidMatch = /ttwid=([^;]+)/.exec(finalCk || "");
      if (ttwidMatch) ttwid = ttwidMatch[1];
      if (full && ttwidMatch && !/(^|;\s*)ttwid=/.test(full)) full += `; ttwid=${ttwid}`;
    }
    // 用页面自带的 frontierSign 为详情 API 现算 a_bogus（与该 URL 绑定，换视频需重算）
    let detailUrl = "";
    let ab: Record<string, string> = {};
    // 始终计算 detailUrl+ab（X-Bogus 路线备用；与 realUrl 路线并存）
    if (videoId) {
      detailUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${videoId}&device_platform=webapp&channel=channel_pc_web&pc_client_type=1&version_code=170400&version_name=17.4.0&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=120.0.0.0&browser_online=true&engine_name=Blink&engine_version=120.0.0.0&os_name=Windows&os_version=10&cpu_core_num=16&device_memory=8&platform=PC&downlink=10&effective_type=4g&round_trip_time=50&msToken=${msToken}`;
      const signJson = await page
        .evaluate(`JSON.stringify((window.byted_acrawler && window.byted_acrawler.frontierSign) ? window.byted_acrawler.frontierSign(${JSON.stringify(detailUrl)}) : {noSdk: !(window.byted_acrawler)})`)
        .catch(() => "{}");
      try { ab = JSON.parse(signJson || "{}"); } catch { ab = {}; }
      // 把 msToken 也补进 Cookie 罐（真实浏览器是 cookie+query 双份）
      if (!/(^|;\s*)msToken=/.test(full)) full += `; msToken=${msToken}`;
    }
    const val = { nonce: nonceMatch[1], signature: sigMatch[1], ttwid, full, msToken, detailUrl, ab, realUrl, uifid };
    await env.DOUYIN_KV!.put("douyin:accookie", JSON.stringify(val), { expirationTtl: 60 * 60 * 24 * 7 });
    return val;
  } finally {
    if (launched) await launched.close();
  }
}

/** 读缓存的引导 Cookie，没有就现场引导 */
async function getDouyinAcCookie(env: Env, videoId?: string): Promise<{ nonce: string; signature: string; ttwid: string; full?: string; msToken?: string; detailUrl?: string; ab?: Record<string, string> }> {
  const cached = await env.DOUYIN_KV!.get("douyin:accookie");
  if (cached) {
    try { return JSON.parse(cached); } catch { /* 重新引导 */ }
  }
  return bootstrapDouyinCookie(env, videoId);
}

/**
 * 注册一个新 ttwid（bytedance 开放注册接口，无需签名/验证码）。
 * ttwid 是设备级 ID，Cookie 缺 ttwid 时抖音 SSR 风控直接上验证码中间页。
 */
async function ensureTtwid(env: Env): Promise<string> {
  const cached = await env.DOUYIN_KV!.get("douyin:ttwid");
  if (cached) return cached;
  const res = await fetch("https://ttwid.bytedance.com/ttwid/union/register/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": PC_UA },
    body: JSON.stringify({
      region: "cn",
      aid: 1768,
      needFid: false,
      service: "www.ixigua.com",
      migrate_info: { ticket: "", source: "node" },
      cbUrlProtocol: "https",
      union: true,
    }),
  });
  const sc = res.headers.get("set-cookie") ?? "";
  const m = /ttwid=([^;]+)/.exec(sc);
  if (!m) throw new Error("TTWID_REG_FAIL status=" + res.status + " sc=" + sc.slice(0, 80));
  await env.DOUYIN_KV!.put("douyin:ttwid", m[1], { expirationTtl: 60 * 60 * 24 * 30 });
  return m[1];
}

/**
 * 住宅出口解析：relay 带 Cookie 抓分享页 SSR（_ROUTER_DATA → videoInfoRes）。
 * 响应退化成空壳/挑战页说明 Cookie 失效，重新引导后再试一次。
 */
async function douyinViaRelay(env: Env, rawUrl: string, trace?: string[]): Promise<{ videoId: string; html: string; item: any } | null> {
  let videoId = getDouyinVideoIdFromUrl(rawUrl);
  if (!videoId) {
    try { videoId = await resolveDouyinVideoIdByFetch(rawUrl); } catch { trace?.push("resolve-id-fail"); return null; }
  }
  if (!videoId) { trace?.push("no-id"); return null; }
  trace?.push("id=" + videoId);
  const type = /\/note\//.test(rawUrl) || /h5|note/.test(videoId) ? "note" : "video";
  const target = `https://www.douyin.com/${type}/${videoId}`;
  let cookie: { nonce: string; signature: string; ttwid: string; full?: string; msToken?: string; detailUrl?: string; ab?: Record<string, string>; realUrl?: string; uifid?: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      cookie = await getDouyinAcCookie(env, videoId);
    } catch (e) { trace?.push("bootstrap-fail:" + (e instanceof Error ? e.message : "e").slice(0, 100)); return null; }
    trace?.push(`attempt${attempt} nonce=${cookie.nonce} sig=${cookie.signature.slice(0, 16)}... ttwid=${cookie.ttwid ? "y" : "n"} full=${cookie.full ? cookie.full.length : 0}b realUrl=${cookie.realUrl ? "y" : "n"}`);
    // 缓存里没有签名 URL（旧引导竞态）→ 清缓存强制重引导，下次循环用新鲜捕获
    if (!cookie.realUrl && attempt === 0) {
      trace?.push("no-realUrl, rebootstrap");
      await env.DOUYIN_KV!.delete("douyin:accookie");
      continue;
    }
    // 优先整罐回放（含 HttpOnly Cookie），缺失时退回三件套
    let ck = cookie.full && /__ac_signature=/.test(cookie.full)
      ? cookie.full
      : `__ac_nonce=${cookie.nonce}; __ac_signature=${cookie.signature}` + (cookie.ttwid ? `; ttwid=${cookie.ttwid}` : "");
    // Cookie 罐里没有 ttwid（引导浏览器常拿不到）→ 用开放接口补注册一个
    if (!/(^|;\s*)ttwid=/.test(ck)) {
      try { ck += `; ttwid=${await ensureTtwid(env)}`; trace?.push("ttwid=registered"); }
      catch (e) { trace?.push("ttwid-reg-fail:" + (e instanceof Error ? e.message : "e").slice(0, 60)); }
    }
    let html = "";
    try {
      // 路线 A：回放页面自己发出的详情 API 请求（完整签名 URL + uifid 头）——住宅 IP 下应能通过
      let apiUrl = "";
      const apiHeaders: Record<string, string> = { "User-Agent": PC_UA, Referer: `https://www.douyin.com/video/${videoId}/`, Cookie: ck };
      if (cookie.realUrl && /aweme_id=([0-9]+)/.exec(cookie.realUrl)?.[1] === videoId) {
        apiUrl = cookie.realUrl;
        if (cookie.uifid) apiHeaders["uifid"] = cookie.uifid;
      } else if (cookie.msToken && cookie.ab) {
        // 路线 B：自构造详情 URL + frontierSign 的 X-Bogus（缺 uifid 可能被拒）
        const abKey = cookie.ab["a_bogus"] ?? cookie.ab["X-Bogus"] ?? "";
        const abName = cookie.ab["a_bogus"] ? "a_bogus" : "X-Bogus";
        if (abKey && cookie.detailUrl) {
          const m = /aweme_id=([0-9]+)/.exec(cookie.detailUrl);
          if (m && m[1] === videoId) apiUrl = `${cookie.detailUrl}&${abName}=${abKey}`;
        }
      }
      if (apiUrl) {
        html = await relayFetch(env, apiUrl, apiHeaders, 2000000);
        trace?.push(`api-route len=${html.length}`);
        if (html.length > 200 && /aweme_detail|"item_list"|"video"/.test(html)) {
          const parsed = extractDouyinItemFromHtml(html);
          if (parsed) { trace?.push("parsed-ok-api"); return { videoId, html, item: parsed.item }; }
        }
        // API 路线拿到空/错误体：签名已过期/失效，清缓存让下次重新引导捕获新鲜签名
        trace?.push("api-route-invalid");
        await env.DOUYIN_KV!.delete("douyin:accookie").catch(() => {});
        return null;
      }
      html = await relayFetch(env, target, { "User-Agent": PC_UA, Referer: "https://www.douyin.com/", Cookie: ck });
    } catch (e) {
      trace?.push("relay-throw:" + (e instanceof Error ? e.message : "e"));
      if (attempt === 1) return null;
      // 403 多为会话签名失效/被风控 → 强制重新引导再试
      await env.DOUYIN_KV!.delete("douyin:accookie").catch(() => {});
      continue;
    }
    trace?.push(`relay-resp len=${html.length} acrawler=${(html.match(/byted_acrawler/g) || []).length} router=${(html.match(/_ROUTER_DATA/g) || []).length} render=${(html.match(/RENDER_DATA/g) || []).length}`);
    if (trace) {
      // 诊断模式：响应体片段帮助定位未知内容（验证后移除）
      const title = /<title[^>]*>([^<]{0,120})/.exec(html)?.[1] ?? "";
      trace.push(`body-title=${title}`);
      trace.push(`body-head=${html.slice(0, 500).replace(/\s+/g, " ").slice(0, 500)}`);
    }
    // 出口服务基建错误（设备离线等）或空响应（ESP32 内存装不下大页面）：不算 Cookie 失效，保留缓存直接放弃
    if (html.length < 200) { trace?.push("infra-or-oversize"); return null; }
    if (/"error"\s*:/.test(html.slice(0, 100))) { trace?.push("infra-error"); return null; }
    const parsed = extractDouyinItemFromHtml(html);
    if (parsed) { trace?.push("parsed-ok"); return { videoId, html, item: parsed.item }; }
    if (attempt === 1) { trace?.push("parse-fail-final"); return null; }
    // 真的拿到了挑战页/空壳页 → Cookie 失效，清缓存重新引导
    trace?.push("cookie-invalid, rebootstrap");
    await env.DOUYIN_KV!.delete("douyin:accookie");
  }
  return null;
}

async function parseDouyin(rawUrl: string, env: Env, browser?: BrowserWorker): Promise<ParsedResult> {
  const isShortLinkUrl = rawUrl.includes("v.douyin.com");
  let videoId = getDouyinVideoIdFromUrl(rawUrl);
  let html = "";
  let viaBrowser = false;
  let item: any = null;

  // Step 0: 分享页 SSR 路线——自注册 ttwid + iesdouyin 分享页直出内嵌数据（无需签名/浏览器/住宅出口）
  if (env.DOUYIN_KV) {
    if (!videoId) {
      try { videoId = await resolveDouyinVideoIdByFetch(rawUrl); } catch { /* 交给后续路线 */ }
    }
    if (videoId) {
      const shareType = /\/note\//.test(rawUrl) ? "note" : "video";
      try {
        const r = await fetchDouyinShareHtml(env, videoId, shareType);
        const parsed = parseDouyinData(r.html);
        if (parsed?.item) {
          html = r.html;
          item = parsed.item;
          viaBrowser = true;
        }
      } catch { /* 分享页失败，走住宅出口/浏览器兜底 */ }
    }
  }

  // Step 1: 住宅出口路线——ESP32 带引导 Cookie 从家里 WiFi 拿 SSR 数据（绕 IP 风控）
  if (!item && env.RELAY_BASE && env.RELAY_KEY && env.DOUYIN_KV && env.BROWSER) {
    try {
      const r = await douyinViaRelay(env, rawUrl);
      if (r) {
        if (!videoId) videoId = r.videoId;
        html = r.html;
        item = r.item ?? null;
        viaBrowser = true;
      }
    } catch { /* 出口失败，走浏览器/直连兜底 */ }
  }

  // Step 2: 无头浏览器——直接导航短链/视频页，真实渲染并主动抠数据破解空壳
  if (!item && browser) {
    try {
      const r = await fetchDouyinViaBrowser(browser, videoId, isShortLinkUrl ? rawUrl : "");
      if (r) {
        if (!videoId) videoId = getDouyinVideoIdFromUrl(r.finalUrl);
        html = r.html;
        item = r.item ?? null;
        viaBrowser = true;
      }
    } catch { /* 浏览器失败，走 fetch 兜底 */ }
  }

  // 从浏览器 HTML 也尝试解析出 item
  if (!item && html) item = extractDouyinItemFromHtml(html);

  // Step 2: 若浏览器未解析出视频 ID，用普通 fetch 跟随重定向兜底
  if (!videoId) {
    try { videoId = await resolveDouyinVideoIdByFetch(rawUrl); } catch { /* 交给下方统一判定 */ }
  }

  // Step 3: 仍无 ID。若有浏览器 HTML 且含有效数据可继续，否则报错
  if (!videoId && !html) throw new Error("DOUYIN_NO_VIDEO_ID");
  if (!videoId && html && !item) {
    const u = extractDouyinUriFromHtml(html);
    if (!u) throw new Error("DOUYIN_NO_VIDEO_ID");
  }

  // Step 5: 有 ID 但既无 item 又无 HTML（分享页/出口/浏览器全失败），按 ID 再抓一次分享页
  if (videoId && !html) {
    const r = await fetchDouyinShareHtml(env, videoId, /\/note\//.test(rawUrl) ? "note" : "video").catch(() => null);
    html = r?.html ?? "";
  }

  // Step 5: 若仍无 item，从 HTML 尽力解析
  if (!item && html) item = extractDouyinItemFromHtml(html);

  // Step 6: 若拿不到 item，则尽力从 HTML 提取 uri 生成直链
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

async function parseUrl(url: string, env: Env, browser?: BrowserWorker): Promise<ParsedResult> {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("UNSUPPORTED_PLATFORM");

  switch (platform) {
    case "tiktok": return parseTikTok(url);
    case "douyin": return parseDouyin(url, env, browser);
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
    const result = await parseUrl(url, env, env.BROWSER);
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
