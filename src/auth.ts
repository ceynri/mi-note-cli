import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getCacheDir, fileExists, ensureDir } from "./utils.js";
import type { AuthInfo } from "./types.js";

const COOKIE_FILE = join(getCacheDir(), "cookie");
const BROWSER_DATA_DIR = join(getCacheDir(), "browser-data");

const NOTE_URL = "https://i.mi.com/note/h5#/";
const NOTE_API_BASE = "https://i.mi.com/note/full/page/";
const LOGIN_TIMEOUT = 300_000;
const POLL_INTERVAL = 2_000;
const CHROME_VERSION = "131";

/**
 * 确保拥有有效的认证信息（cookie + serviceToken + userId）。
 *
 * 解析顺序：
 * 1. forceLogin=true → 直接浏览器登录。
 * 2. 缓存 cookie 有效 → 使用。
 * 3. 否则 → 浏览器登录。
 */
export async function ensureAuth(forceLogin = false): Promise<AuthInfo> {
  if (!forceLogin) {
    const cached = await loadCachedCookie(COOKIE_FILE);
    if (cached && (await validateCookie(cached))) {
      return buildAuthInfo(cached);
    }
  }

  const cookie = await loginAndGetCookie();
  await saveCookie(cookie);
  return buildAuthInfo(cookie);
}

/**
 * 仅读取当前缓存的认证信息，不触发登录。无有效缓存时返回 null。
 * 用于 whoami 等只查询不登录的场景。
 */
export async function peekAuth(): Promise<AuthInfo | null> {
  const cached = await loadCachedCookie(COOKIE_FILE);
  if (cached && (await validateCookie(cached))) {
    return buildAuthInfo(cached);
  }
  return null;
}

/** 清除自身缓存（cookie + 浏览器数据） */
export async function clearAuthCache(): Promise<string> {
  const dir = getCacheDir();
  if (await fileExists(dir)) {
    await rm(dir, { recursive: true, force: true });
  }
  return dir;
}

/** 从 cookie 字符串构造 AuthInfo（提取 serviceToken / userId） */
function buildAuthInfo(cookie: string): AuthInfo {
  return {
    cookie,
    serviceToken: extractCookieValue(cookie, "serviceToken"),
    userId: extractCookieValue(cookie, "userId", false),
  };
}

/** 从 cookie 字符串中提取某字段值 */
export function extractCookieValue(
  cookie: string,
  key: string,
  required = true,
): string {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  if (!match) {
    if (required) {
      throw new Error(`Cookie 中未找到 ${key}，请重新登录（mi-note-cli login）`);
    }
    return "";
  }
  return match[1];
}

/**
 * 通过 Playwright 打开浏览器让用户登录，获取 Cookie。
 * 浏览器策略：优先系统 Chrome（真签名），回退 Playwright Chromium。
 */
async function loginAndGetCookie(): Promise<string> {
  console.error("🌐 正在打开浏览器，请在浏览器中登录小米账号...");

  const { chromium } = await import("playwright");
  // 启用沙箱并移除 Playwright 默认追加的 --no-sandbox，
  // 避免浏览器顶部出现「您使用的是不受支持的命令行标记 --no-sandbox」警告条。
  const launchOptions = {
    headless: false,
    chromiumSandbox: true,
    ignoreDefaultArgs: ["--no-sandbox", "--enable-automation"],
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
      ...launchOptions,
      channel: "chrome",
    });
  } catch {
    console.error("⚠️ 未检测到系统 Chrome，回退到 Playwright 自带 Chromium");
    context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
      ...launchOptions,
      channel: "chromium",
    });
  }

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(NOTE_URL);
  console.error("⏳ 等待登录完成...（登录成功后会自动检测）");

  const startTime = Date.now();
  while (Date.now() - startTime < LOGIN_TIMEOUT) {
    try {
      const loggedIn = await page.evaluate(() => {
        const isNotePage = location.href.includes("i.mi.com/note");
        const hasContent =
          document.querySelector(".note-list") ||
          document.querySelector('[class*="note"]') ||
          document.querySelector('[class*="list"]');
        return isNotePage && !!hasContent;
      });
      if (loggedIn) break;
    } catch {
      // 页面导航中，evaluate 失败，忽略
    }

    try {
      const cookieStr = await extractCookies(context);
      if (cookieStr && (await validateCookie(cookieStr))) break;
    } catch {
      // ignore
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  if (Date.now() - startTime >= LOGIN_TIMEOUT) {
    await context.close();
    throw new Error("登录超时（5 分钟），请重试");
  }

  console.error("✅ 登录成功，正在提取 Cookie...");
  const cookieStr = await extractCookies(context);
  await context.close();

  if (!cookieStr) {
    throw new Error("未能获取到 Cookie，请重试");
  }
  return cookieStr;
}

async function extractCookies(context: {
  cookies: (url: string) => Promise<{ name: string; value: string }[]>;
}): Promise<string> {
  const cookies = await context.cookies("https://i.mi.com");
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** 校验 cookie 是否有效 */
export async function validateCookie(cookie: string): Promise<boolean> {
  try {
    const url = `${NOTE_API_BASE}?ts=${Date.now()}&limit=1`;
    const resp = await fetch(url, { headers: buildHeaders(cookie) });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { result: string };
    return data.result === "ok";
  } catch {
    return false;
  }
}

/** 构建请求头 */
export function buildHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Referer: "https://i.mi.com/note/h5",
    Origin: "https://i.mi.com",
    "User-Agent": `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "sec-ch-ua": `"Google Chrome";v="${CHROME_VERSION}", "Chromium";v="${CHROME_VERSION}", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

async function loadCachedCookie(file: string): Promise<string | null> {
  if (!(await fileExists(file))) return null;
  try {
    const content = await readFile(file, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function saveCookie(cookie: string): Promise<void> {
  await ensureDir(getCacheDir());
  await writeFile(COOKIE_FILE, cookie, "utf-8");
}
