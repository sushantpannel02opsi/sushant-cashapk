// server.cjs
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

const MAINTENANCE_MODE = String(process.env.MAINTENANCE_MODE || "false").toLowerCase() === "true";

app.use((req, res, next) => {
  if (!MAINTENANCE_MODE) return next();

  // allow health checks
  if (req.path === "/health") return res.status(200).send("ok");

  // allow the maintenance page itself + assets if you add any
  if (req.path === "/maintenance.html") return next();

  // for everything else: show maintenance page
  res.status(503);
  return res.sendFile(__dirname + "/maintenance.html");
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get("/health", (req, res) => res.status(200).send("ok"));

/* ===============================
   SIMPLE MEMORY CACHE (FAST)
================================= */

const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours
const tiktokCache = new Map();

function getCache(key) {
  const hit = tiktokCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL) {
    tiktokCache.delete(key);
    return null;
  }
  return hit;
}

function setCache(key, data) {
  tiktokCache.set(key, { ...data, time: Date.now() });
}

/* ===============================
   PLAYWRIGHT SINGLE BROWSER
================================= */

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

/* ===============================
   PROXY IMAGE (FOR TIKTOK)
================================= */

app.get("/proxy-image", async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send("Missing url");

    const r = await fetch(imageUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!r.ok) return res.status(502).send("Image fetch failed");

    const contentType = r.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const buffer = await r.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error("proxy error:", e);
    res.status(500).send("Proxy error");
  }
});

/* ===============================
   FAST TIKTOK ENDPOINT
================================= */

app.get("/tiktok", async (req, res) => {
  let user = (req.query.user || "").toString().trim();
  if (!user) return res.status(400).json({ error: "Missing user" });

  const username = user.replace(/^@/, "").toLowerCase();

  // 1️⃣ RETURN CACHE INSTANTLY
  const cached = getCache(username);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(
    username
  )}?lang=en`;

  let context;
  let page;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      locale: "en-US",
      viewport: { width: 900, height: 900 },
    });

    page = await context.newPage();

    // 🚀 BLOCK HEAVY FILES (MAJOR SPEED BOOST)
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    // Extract JSON data
    const universalText = await page
      .locator('script#__UNIVERSAL_DATA_FOR_REHYDRATION__')
      .textContent()
      .catch(() => null);

    let avatar = null;
    let displayName = null;

    if (universalText) {
      try {
        const json = JSON.parse(universalText);

        const queue = [json];
        while (queue.length) {
          const node = queue.shift();
          if (!node) continue;

          if (typeof node === "object") {
            for (const [k, v] of Object.entries(node)) {
              if (!displayName && (k === "nickname" || k === "displayName")) {
                displayName = v;
              }
              if (!avatar && (k === "avatarLarger" || k === "avatarMedium")) {
                avatar = v;
              }
              if (v && typeof v === "object") queue.push(v);
            }
          }
        }
      } catch {}
    }

    if (avatar) {
      avatar = `/proxy-image?url=${encodeURIComponent(avatar)}`;
    }

    const payload = {
      name: displayName || username,
      username,
      avatar: avatar || null,
    };

    setCache(username, payload);

    res.setHeader(
      "Cache-Control",
      "public, max-age=60, s-maxage=86400, stale-while-revalidate=86400"
    );

    return res.json({ ...payload, cached: false });
  } catch (e) {
    console.error("tiktok error:", e);
    return res.status(500).json({ error: "TikTok fetch failed" });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
});

/* ===============================
   START SERVER
================================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
