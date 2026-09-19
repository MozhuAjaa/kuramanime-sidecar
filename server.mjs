/**
 * Kuramanime Playwright sidecar
 *
 * Kuramanime builds its player entirely in the browser: the episode POST needs
 * an `authorization` value produced by its obfuscated token bundle, so the
 * <source> list cannot be reproduced with plain HTTP. This service performs that
 * handshake in Chromium and reports the filled sources over JSON.
 *
 * It exists as a separate service because a Vercel function cannot run Chromium
 * (250 MB bundle limit, read-only filesystem, no shared libraries).
 *
 * Endpoints
 *   GET /health          liveness probe, no auth (Railway healthcheck)
 *   GET /resolve?url=    extract the player sources from one episode page
 */
import http from "node:http";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT ?? process.env.SIDECAR_PORT ?? 8080);
const HOST = process.env.SIDECAR_HOST ?? "0.0.0.0";
const TOKEN = (process.env.SIDECAR_TOKEN ?? "").trim();

const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS ?? 30_000);
const PLAYER_TIMEOUT_MS = Number(process.env.PLAYER_TIMEOUT_MS ?? 25_000);

/** Hosts this service may drive a browser at; keeps it from being an open browser. */
const DEFAULT_ALLOWED_HOSTS = ["kuramanime.run", "kuramanime.xyz", "kuramanime.blog"];
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS.join(","))
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const HEADLESS = (process.env.HEADLESS ?? "true").trim().toLowerCase() !== "false";
const CHANNEL = (process.env.BROWSER_CHANNEL ?? "").trim() || undefined;

const UA =
  process.env.SIDECAR_UA?.trim() ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const CHROMIUM_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--lang=id-ID"];

let browserPromise = null;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, status, error, message) {
  send(res, status, { ok: false, error, ...(message ? { message: String(message).slice(0, 300) } : {}) });
}

function hostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ headless: HEADLESS, args: CHROMIUM_ARGS, ...(CHANNEL ? { channel: CHANNEL } : {}) })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }
  return browserPromise;
}

/** One context per request: the player token is bound to its own page session. */
async function resolveEpisode(target) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    locale: "id-ID",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    // The player fills <source> after its token round-trip; <source> is never
    // "visible", so wait on presence rather than visibility.
    await page.waitForFunction(
      () => {
        const player = document.getElementById("player");
        if (!player) return false;
        const hls = player.getAttribute("data-hls-src");
        return player.querySelectorAll("source[src]").length > 0 || Boolean(hls);
      },
      null,
      { timeout: PLAYER_TIMEOUT_MS },
    );
    const data = await page.evaluate(() => {
      const player = document.getElementById("player");
      const sources = [...(player?.querySelectorAll("source") ?? [])].map((element) => ({
        quality: element.getAttribute("size") ?? null,
        url: element.getAttribute("src") ?? null,
      }));
      return {
        hlsSrc: player?.getAttribute("data-hls-src") || null,
        servers: [...document.querySelectorAll("#changeServer option")].map((option) => option.value),
        sources: sources.filter((source) => source.url),
        title: document.getElementById("episodeTitle")?.textContent?.trim() ?? null,
      };
    });
    return { ok: true, ...data };
  } finally {
    await context.close().catch(() => {});
  }
}

function authorized(req) {
  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-sidecar-token"] ?? "");
  return typeof provided === "string" && provided === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (url.pathname === "/health") {
    return send(res, 200, { ok: true, uptime: process.uptime(), browser: Boolean(browserPromise) });
  }

  if (!authorized(req)) return fail(res, 401, "unauthorized");

  if (url.pathname !== "/resolve") return fail(res, 404, "not_found");

  const target = url.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) return fail(res, 400, "invalid_url");

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return fail(res, 400, "invalid_url");
  }
  if (!hostAllowed(parsed.hostname)) return fail(res, 403, "host_not_allowed");

  try {
    return send(res, 200, await resolveEpisode(target));
  } catch (error) {
    return fail(res, 502, String(error?.name ?? "error"), error?.message ?? error);
  }
});

async function shutdown() {
  const browser = await browserPromise?.catch(() => null);
  await browser?.close().catch(() => {});
  server.close(() => process.exit(0));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, shutdown);
}

if (!TOKEN) {
  console.error("SIDECAR_TOKEN is not set. Refusing to expose an unauthenticated browser.");
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`kuramanime sidecar listening on http://${HOST}:${PORT}`);
  console.log(`allowed hosts: ${ALLOWED_HOSTS.join(", ")}`);
});
