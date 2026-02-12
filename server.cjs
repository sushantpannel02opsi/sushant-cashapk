// server.cjs
// ✅ TikTok: fetch avatar + display name (nickname) + username + cache + proxy-image
// ✅ Added strong fallback for name: regex from embedded JSON text
// ✅ Railway/Fly/Render friendly: process.env.PORT + 0.0.0.0
// ✅ Cash: safe confirmUrl only (no Cash App scraping)

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get("/health", (req, res) => res.status(200).send("ok"));

function normalizeUrl(u) {
  if (!u) return null;
  let url = String(u).trim();
  if (url.startsWith("//")) url = "https:" + url;
  return url;
}

function isAllowedProxyUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// --------------------
// Cache (instant on repeat)
// --------------------
const tiktokCache = new Map(); // username -> { name, username, avatar, time }
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours
const tiktokInFlight = new Map(); // username -> Promise(payload)

function cacheGet(username) {
  const hit = tiktokCache.get(username);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL) {
    tiktokCache.delete(username);
    return null;
  }
  return hit;
}

function cacheSet(username, payload) {
  tiktokCache.set(username, { ...payload, time: Date.now() });
}

// --------------------
// Reuse one browser (speed)
// --------------------
let browserInstance = null;

async function getBrowser() {
  if (browserInstance) return browserInstance;

  browserInstance = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  return browserInstance;
}

// --------------------
// Proxy image (hotlink/CORS bypass)
// --------------------
app.get("/proxy-image", async (req, res) => {
  try {
    let imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send("Missing url");

    imageUrl = normalizeUrl(imageUrl);
    if (!imageUrl || !isAllowedProxyUrl(imageUrl)) {
      return res.status(400).send("Invalid url");
    }

    const r = await fetch(imageUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        referer: "https://www.tiktok.com/",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!r.ok) return res.status(502).send(`proxy failed: ${r.status}`);

    const contentType = r.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const arrayBuffer = await r.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    console.error("proxy-image error:", e);
    res.status(500).send("proxy error");
  }
});

// --------------------
// TikTok JSON helpers
// --------------------
function extractFirstStringByKeys(obj, keysSet) {
  const queue = [obj];
  while (queue.length) {
    const node = queue.shift();
    if (!node) continue;

    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (keysSet.has(k) && typeof v === "string" && v.length > 1) return v;
        if (v && typeof v === "object") queue.push(v);
      }
    }
  }
  return null;
}

function extractAvatarFromUniversalJson(obj) {
  return extractFirstStringByKeys(
    obj,
    new Set(["avatarLarger", "avatarMedium", "avatarThumb", "avatarUri"])
  );
}

function extractDisplayNameFromUniversalJson(obj) {
  return extractFirstStringByKeys(obj, new Set(["nickname", "displayName", "nickName"]));
}

// ✅ Strong fallback: extract nickname from raw embedded JSON text
function extractNicknameFromRawText(raw) {
  if (!raw) return null;

  const patterns = [
    /"nickname"\s*:\s*"([^"]+)"/i,
    /"displayName"\s*:\s*"([^"]+)"/i,
    /"nickName"\s*:\s*"([^"]+)"/i
  ];

  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      return m[1]
        .replace(/\\u002F/g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\n/g, " ")
        .replace(/\\"/g, '"')
        .trim();
    }
  }
  return null;
}

// --------------------
// TikTok endpoint
// --------------------
app.get("/tiktok", async (req, res) => {
  let user = (req.query.user || "").toString().trim();
  if (!user) return res.status(400).json({ error: "Missing user" });

  const username = user.replace(/^@/, "").toLowerCase();

  // ✅ instant on repeat
  const cached = cacheGet(username);
  if (cached) {
    return res.json({ ...cached, blocked: false, cached: true });
  }

  // ✅ coalesce in-flight requests for same username (typing-friendly)
  const pending = tiktokInFlight.get(username);
  if (pending) {
    try {
      const payload = await pending;
      return res.json({ ...payload, cached: false, inflight: true });
    } catch (e) {
      return res.status(500).json({ error: "TikTok fetch failed", details: String(e) });
    }
  }

  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}?lang=en`;

  const task = (async () => {
    let context;
    let page;

    try {
      const browser = await getBrowser();

      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        locale: "en-US",
        viewport: { width: 900, height: 900 },
      });

      page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(15000);

      // ✅ speed: block heavy resources
      await page.route("**/*", (route) => {
        const rt = route.request().resourceType();
        if (["image", "media", "font", "stylesheet"].includes(rt)) return route.abort();
        return route.continue();
      });

      await page.goto(profileUrl, { waitUntil: "domcontentloaded" });

      const universalText = await page
        .locator('script#__UNIVERSAL_DATA_FOR_REHYDRATION__')
        .textContent()
        .catch(() => null);

      let avatar = null;
      let displayName = null;

      if (universalText) {
        try {
          const json = JSON.parse(universalText);
          avatar = extractAvatarFromUniversalJson(json);

          // structured lookup
          displayName = extractDisplayNameFromUniversalJson(json);

          // ✅ fallback regex from raw text
          if (!displayName) {
            displayName = extractNicknameFromRawText(universalText);
          }
        } catch {
          // Even if JSON parse fails, try regex
          displayName = extractNicknameFromRawText(universalText);
        }
      }

      // Fallback: og:image (avatar only)
      if (!avatar) {
        avatar = await page
          .locator('meta[property="og:image"]')
          .getAttribute("content")
          .catch(() => null);
      }

      if (avatar) {
        avatar = avatar
          .replace(/\\u002F/g, "/")
          .replace(/\\u0026/g, "&")
          .replace(/\\\//g, "/");

        avatar = normalizeUrl(avatar);
        const proxied = avatar ? `/proxy-image?url=${encodeURIComponent(avatar)}` : null;

        const payload = {
          name: displayName || username, // ✅ TikTok display name if found
          username,
          avatar: proxied,
          blocked: false,
        };

        cacheSet(username, payload);

        return payload;
      }

      return {
        name: username,
        username,
        avatar: null,
        blocked: true,
      };
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }
  })();

  tiktokInFlight.set(username, task);

  try {
    const payload = await task;
    return res.json({ ...payload, cached: false, inflight: false });
  } catch (e) {
    console.error("tiktok error:", e);
    return res.status(500).json({ error: "TikTok fetch failed", details: String(e) });
  } finally {
    tiktokInFlight.delete(username);
  }
});

// --------------------
// Cash (safe: confirm link only)
// --------------------
app.get("/cash", (req, res) => {
  let tag = (req.query.tag || "").toString().trim();
  if (!tag) return res.status(400).json({ error: "Missing tag" });

  if (!tag.startsWith("$")) tag = "$" + tag;

  res.json({
    cashtag: tag,
    name: tag.replace(/^\$/, ""),
    avatar: null,
    confirmUrl: `https://cash.app/${encodeURIComponent(tag)}`,
  });
});

// --------------------
// Start
// --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
