import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  getUpdaterStatus,
  setUpdaterConfig,
  checkForPluginUpdate,
  performPluginUpdate
} from "./plugin-updater.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  BUILTIN_READONLY_EXAMPLES,
  resolveHostHomeDir,
  getRulesFilePath,
  getDefaultPolicyConfig,
  readCommandPolicyConfig,
  writeCommandPolicyConfig,
  evaluateCommandPolicy
} = require("../../lib/command-policy.cjs");
const { isPureReadOnlyCommand } = require("../../lib/read-only-audit.cjs");

const HOME_DIR = resolveHostHomeDir();
const APP_DATA_DIR = (process.platform === "win32" && fs.existsSync(path.join(HOME_DIR, "AppData", "Roaming")))
  ? path.join(HOME_DIR, "AppData", "Roaming")
  : (process.env.APPDATA || (process.platform === "darwin" ? path.join(HOME_DIR, "Library", "Application Support") : path.join(HOME_DIR, ".config")));
const PLUGINS_DIR = path.join(HOME_DIR, ".gemini", "config", "plugins");
const CONFIG_FILE = path.join(HOME_DIR, ".gemini", "config", "config.json");
const APP_STORAGE_FILE = path.join(APP_DATA_DIR, "Antigravity", "app_storage.json");

let cachedHostAppearance = { mtimeMs: -1, storageMtimeMs: -1, value: { fontSizePx: null, fontFamily: "" } };

function parseHostConfigFontPx(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 9 && raw <= 36 ? raw : null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  const upper = str.toUpperCase();
  if (upper.includes("SMALL") || upper === "SM") return 12;
  if (upper.includes("LARGE") && !upper.includes("EXTRA")) return 16;
  if (upper.includes("EXTRA_LARGE") || upper === "XL") return 18;
  if (upper.includes("DEFAULT") || upper.includes("MEDIUM") || upper === "MD") return 14;
  const pxMatch = str.match(/^(\d+(?:\.\d+)?)\s*px$/i);
  if (pxMatch) {
    const n = parseFloat(pxMatch[1]);
    return Number.isFinite(n) && n >= 9 && n <= 36 ? n : null;
  }
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const n = parseFloat(str);
    return Number.isFinite(n) && n >= 9 && n <= 36 ? n : null;
  }
  return null;
}

function readHostAppearanceFromConfig() {
  try {
    const cfgMtimeMs = fs.existsSync(CONFIG_FILE) ? fs.statSync(CONFIG_FILE).mtimeMs : 0;
    const storMtimeMs = fs.existsSync(APP_STORAGE_FILE) ? fs.statSync(APP_STORAGE_FILE).mtimeMs : 0;
    if (
      cachedHostAppearance.mtimeMs === cfgMtimeMs &&
      cachedHostAppearance.storageMtimeMs === storMtimeMs
    ) {
      return cachedHostAppearance.value;
    }
    let fontSizePx = null;
    let fontFamily = "";
    if (cfgMtimeMs > 0) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      const us = parsed?.userSettings && typeof parsed.userSettings === "object" ? parsed.userSettings : {};
      for (const k of ["fontSize", "uiFontSize", "chatFontSize", "baseFontSize", "textSize", "appearanceFontSize"]) {
        const px = parseHostConfigFontPx(us[k]);
        if (px !== null) {
          fontSizePx = px;
          break;
        }
      }
      for (const k of ["fontFamily", "font", "uiFontFamily", "appearanceFontFamily"]) {
        const fam = typeof us[k] === "string" ? us[k].trim() : "";
        if (fam && !/^(default|inherit|auto)$/i.test(fam)) {
          fontFamily = fam;
          break;
        }
      }
    }
    if ((fontSizePx === null || !fontFamily) && storMtimeMs > 0) {
      const stor = JSON.parse(fs.readFileSync(APP_STORAGE_FILE, "utf8"));
      if (fontSizePx === null) {
        for (const k of ["fontSize", "uiFontSize", "chatFontSize", "baseFontSize"]) {
          const px = parseHostConfigFontPx(stor?.[k]);
          if (px !== null) {
            fontSizePx = px;
            break;
          }
        }
      }
      if (!fontFamily) {
        for (const k of ["fontFamily", "font", "uiFontFamily"]) {
          const fam = typeof stor?.[k] === "string" ? stor[k].trim() : "";
          if (fam && !/^(default|inherit|auto)$/i.test(fam)) {
            fontFamily = fam;
            break;
          }
        }
      }
    }
    const result = { fontSizePx, fontFamily };
    cachedHostAppearance = { mtimeMs: cfgMtimeMs, storageMtimeMs: storMtimeMs, value: result };
    return result;
  } catch {
    return { fontSizePx: null, fontFamily: "" };
  }
}
const PRELOAD_SDK_PATH = path.join(HOME_DIR, ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "preload.js");
const RULES_FILE = getRulesFilePath();
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 8090);

const STANDALONE_CANDIDATE_PORTS = (() => {
  const rawPreferred = Number(process.env.PLAN_GUARD_PORT || 0);
  const base = [8090, 8092, 8093, 8094, 8095, 8096, 8097, 8099, 8100];
  const seen = new Set();
  const list = [];
  if (Number.isInteger(rawPreferred) && rawPreferred > 1024 && rawPreferred < 65535) {
    seen.add(rawPreferred);
    list.push(rawPreferred);
  }
  for (const p of base) {
    if (!seen.has(p)) {
      seen.add(p);
      list.push(p);
    }
  }
  list.push(0);
  return list;
})();

let actualPrimaryPort = PORT;
let actualStandalonePort = 0;
const boundPorts = new Set();

let configRevision = 1;
let lastInternalWriteAt = 0;
let lsProbeFailCount = 0;

process.on("uncaughtException", (err) => {
  console.error("[PlanGuard Sidecar] Uncaught exception:", err?.stack || err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[PlanGuard Sidecar] Unhandled rejection:", reason);
});

function parseHostLsAddress() {
  const raw = String(process.env.ANTIGRAVITY_LS_ADDRESS || "").trim();
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  if (idx <= 0) return null;
  const host = raw.slice(0, idx).replace(/^\[|\]$/g, "").trim() || "127.0.0.1";
  const port = Number(raw.slice(idx + 1));
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host, port };
}

function probeHostLsTcpOnce(timeoutMs = 1500) {
  const target = parseHostLsAddress();
  if (!target) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const sock = net.createConnection({ host: target.host, port: target.port });
      sock.setTimeout(timeoutMs);
      sock.once("connect", () => {
        try { sock.destroy(); } catch {}
        done(true);
      });
      sock.once("timeout", () => {
        try { sock.destroy(); } catch {}
        done(false);
      });
      sock.once("error", () => {
        try { sock.destroy(); } catch {}
        done(false);
      });
    } catch {
      done(false);
    }
  });
}

async function checkHostLanguageServerAlive() {
  if (!process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) return true;
  const ppid = Number(process.env.AGY_PARENT_LS_PID || process.ppid || 0);
  if (ppid > 0) {
    try {
      process.kill(ppid, 0);
    } catch (err) {
      if (err && err.code === "ESRCH") {
        process.exit(0);
      }
    }
  }
  if (parseHostLsAddress()) {
    const alive = await probeHostLsTcpOnce(1200);
    if (alive) {
      lsProbeFailCount = 0;
    } else if (process.uptime() > 15) {
      lsProbeFailCount += 1;
      if (lsProbeFailCount >= 2) {
        process.exit(0);
      }
    }
  }
  return true;
}

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  setInterval(() => { checkHostLanguageServerAlive().catch(() => {}); }, 5000).unref();
  try {
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("close", () => process.exit(0));
  } catch {}
}

// 后端文件变更自动退出由宿主 restart_policy: always 拉起最新代码
for (const watchPath of [path.join(__dirname, "main.mjs"), path.join(__dirname, "plugin-updater.mjs"), path.resolve(__dirname, "../../lib/command-policy.cjs")]) {
  try {
    fs.watchFile(watchPath, { interval: 1500, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        console.log(`[PlanGuard Sidecar] Backend file ${path.basename(watchPath)} updated on disk, restarting...`);
        setTimeout(() => process.exit(0), 200);
      }
    });
  } catch {}
}

function buildVersionToken(cfg) {
  return `${configRevision}:${cfg?.updatedAt || 0}:${cfg?.mode || "whitelist"}:${cfg?.whitelist?.length || 0}:${cfg?.blacklist?.length || 0}`;
}

const sseClients = new Set();

function closeSseClient(res) {
  try { sseClients.delete(res); } catch {}
  try { if (!res.destroyed && !res.writableEnded) res.end(); } catch {}
}

function broadcastSseState() {
  if (sseClients.size === 0) return;
  const cfg = readCommandPolicyConfig();
  const payload = JSON.stringify({
    success: true,
    config: cfg,
    version: buildVersionToken(cfg),
    builtinReadOnlyExamples: BUILTIN_READONLY_EXAMPLES
  });
  for (const res of [...sseClients]) {
    try {
      if (res.destroyed || res.writableEnded) {
        closeSseClient(res);
      } else {
        res.write(`data: ${payload}\n\n`);
      }
    } catch {
      closeSseClient(res);
    }
  }
}

setInterval(() => {
  if (sseClients.size === 0) return;
  for (const res of [...sseClients]) {
    try {
      if (res.destroyed || res.writableEnded) {
        closeSseClient(res);
      } else {
        res.write(": keepalive\n\n");
      }
    } catch {
      closeSseClient(res);
    }
  }
}, 25000).unref();

let rulesWatchTimer = null;
try {
  const rulesDir = path.dirname(RULES_FILE);
  const rulesName = path.basename(RULES_FILE);
  if (fs.existsSync(rulesDir)) {
    fs.watch(rulesDir, { persistent: false }, (_ev, filename) => {
      if (filename && filename !== rulesName) return;
      if (Date.now() - lastInternalWriteAt < 500) return;
      if (rulesWatchTimer) clearTimeout(rulesWatchTimer);
      rulesWatchTimer = setTimeout(() => {
        rulesWatchTimer = null;
        configRevision += 1;
        broadcastSseState();
      }, 120);
    });
  }
} catch {}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      try { resolve(raw.trim() ? JSON.parse(raw) : {}); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate"
  });
  res.end(payload);
}

function serveStaticFile(res, filePath, contentType) {
  if (fs.existsSync(filePath)) {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end(`${path.basename(filePath)} not found`);
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sidecar-Token");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && pathname === "/api/restart-sidecar") {
    const onlyStandalone = url.searchParams.get("onlyStandalone") === "1";
    if (onlyStandalone && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
      const lsAlive = await probeHostLsTcpOnce(400);
      if (lsAlive) {
        return sendJson(res, 200, { success: false, ignored: true, service: "plan-guard-panel", reason: "already_host_sidecar" });
      }
      sendJson(res, 200, { success: true, evictedStaleParent: true, service: "plan-guard-panel" });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    sendJson(res, 200, { success: true, service: "plan-guard-panel", message: "Sidecar restarting..." });
    setTimeout(() => process.exit(0), onlyStandalone ? 150 : 200);
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return serveStaticFile(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/styles.css") {
    return serveStaticFile(res, path.join(__dirname, "styles.css"), "text/css; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/i18n.js") {
    return serveStaticFile(res, path.join(__dirname, "i18n.js"), "application/javascript; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/ui-prefs.js") {
    return serveStaticFile(res, path.join(__dirname, "ui-prefs.js"), "application/javascript; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/app.js") {
    return serveStaticFile(res, path.join(__dirname, "app.js"), "application/javascript; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/preload.js") {
    if (fs.existsSync(PRELOAD_SDK_PATH)) {
      return serveStaticFile(res, PRELOAD_SDK_PATH, "application/javascript; charset=utf-8");
    }
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end("/* sidecar preload unavailable */\n");
  }

  if (req.method === "GET" && pathname === "/api/config") {
    const cfg = readCommandPolicyConfig();
    return sendJson(res, 200, {
      success: true,
      config: cfg,
      version: buildVersionToken(cfg),
      primaryPort: actualPrimaryPort,
      standalonePort: actualStandalonePort || actualPrimaryPort,
      builtinReadOnlyExamples: BUILTIN_READONLY_EXAMPLES,
      hostAppearance: readHostAppearanceFromConfig()
    });
  }

  if (req.method === "GET" && pathname === "/api/updater-status") {
    try {
      return sendJson(res, 200, { success: true, ...(await getUpdaterStatus()) });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }
  if (req.method === "POST" && pathname === "/api/updater-check") {
    try {
      return sendJson(res, 200, await checkForPluginUpdate({ force: true }));
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }
  if (req.method === "POST" && pathname === "/api/updater-config") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      return sendJson(res, 200, { success: true, ...(await setUpdaterConfig(body)) });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }
  if (req.method === "POST" && pathname === "/api/updater-apply") {
    try {
      const result = await performPluginUpdate({
        onUpdatedRestart: () => setTimeout(() => process.exit(0), 250)
      });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/state-version") {
    const cfg = readCommandPolicyConfig();
    return sendJson(res, 200, {
      success: true,
      version: buildVersionToken(cfg),
      primaryPort: actualPrimaryPort,
      standalonePort: actualStandalonePort || actualPrimaryPort,
      mode: cfg.mode,
      whitelistCount: cfg.whitelist.length,
      blacklistCount: cfg.blacklist.length
    });
  }

  if (req.method === "POST" && pathname === "/api/config") {
    try {
      const body = await readJsonBody(req);
      const current = readCommandPolicyConfig();
      const nextInput = {
        ...current,
        ...(body && typeof body === "object" ? body : {})
      };
      lastInternalWriteAt = Date.now();
      const saved = writeCommandPolicyConfig(nextInput);
      if (saved.written) {
        configRevision += 1;
        broadcastSseState();
      }
      return sendJson(res, 200, {
        success: true,
        config: saved.config,
        version: buildVersionToken(saved.config),
        written: saved.written
      });
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }
  }

  if (req.method === "POST" && pathname === "/api/reset-defaults") {
    try {
      const { scope = "blacklist" } = await readJsonBody(req);
      const current = readCommandPolicyConfig();
      const defaults = getDefaultPolicyConfig();
      const next = { ...current };
      if (scope === "whitelist" || scope === "all") next.whitelist = defaults.whitelist;
      if (scope === "blacklist" || scope === "all") next.blacklist = defaults.blacklist;
      if (scope === "all") {
        next.mode = defaults.mode;
        next.includeBuiltinReadOnly = defaults.includeBuiltinReadOnly;
      }
      lastInternalWriteAt = Date.now();
      const saved = writeCommandPolicyConfig(next);
      configRevision += 1;
      broadcastSseState();
      return sendJson(res, 200, {
        success: true,
        config: saved.config,
        version: buildVersionToken(saved.config)
      });
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }
  }

  if (req.method === "POST" && pathname === "/api/test-command") {
    try {
      const { command = "", config = null } = await readJsonBody(req);
      const result = evaluateCommandPolicy(command, isPureReadOnlyCommand, config || undefined);
      return sendJson(res, 200, { success: true, result });
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }
  }

  if (req.method === "POST" && pathname === "/api/set-language") {
    try {
      const { lang } = await readJsonBody(req);
      const isEn = lang === "en";
      const pluginJsonPath = path.join(PLUGINS_DIR, "plan-guard", "plugin.json");
      const localSidecarPath = path.join(__dirname, "sidecar.json");
      const targetDisplayName = isEn ? "Plan Guard" : "方案先行门禁 (Plan Guard)";
      const targetSidecarTitle = isEn ? "Plan Guard" : "方案门禁";

      if (fs.existsSync(pluginJsonPath)) {
        const rawPj = fs.readFileSync(pluginJsonPath, "utf8");
        const pj = JSON.parse(rawPj);
        if (pj.displayName !== targetDisplayName) {
          pj.displayName = targetDisplayName;
          fs.writeFileSync(pluginJsonPath, JSON.stringify(pj, null, 2) + "\n", "utf8");
        }
      }
      if (fs.existsSync(localSidecarPath)) {
        const rawSj = fs.readFileSync(localSidecarPath, "utf8");
        const sj = JSON.parse(rawSj);
        const curViewTitle = sj.ui_config?.views?.[0]?.title;
        if (sj.display_name !== targetSidecarTitle || curViewTitle !== targetSidecarTitle) {
          sj.display_name = targetSidecarTitle;
          if (sj.ui_config?.views?.[0]) sj.ui_config.views[0].title = targetSidecarTitle;
          fs.writeFileSync(localSidecarPath, JSON.stringify(sj, null, 2) + "\n", "utf8");
        }
      }
      return sendJson(res, 200, { success: true, lang: isEn ? "en" : "zh" });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/events") {
    while (sseClients.size >= 2) {
      const oldest = sseClients.values().next().value;
      if (oldest) closeSseClient(oldest);
      else break;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    sseClients.add(res);
    const cfg = readCommandPolicyConfig();
    res.write(`data: ${JSON.stringify({
      success: true,
      config: cfg,
      version: buildVersionToken(cfg),
      builtinReadOnlyExamples: BUILTIN_READONLY_EXAMPLES
    })}\n\n`);
    req.on("close", () => closeSseClient(res));
    req.on("error", () => closeSseClient(res));
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
}

function configureHttpServer(srv) {
  srv.keepAliveTimeout = 4000;
  srv.headersTimeout = 6000;
  return srv;
}

function evictStalePlanGuardOnPort(port) {
  return new Promise((resolve) => {
    if (!port || port <= 0) return resolve(false);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/restart-sidecar?onlyStandalone=1",
        method: "POST",
        timeout: 500
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return done(false);
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            done(Boolean(data && data.service === "plan-guard-panel" && data.success === true));
          } catch {
            done(false);
          }
        });
      }
    );
    req.on("error", () => done(false));
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.end();
  });
}

function bindServerWithFallback(candidates, onListening) {
  const tryIdx = (idx, retriedCurrent = false) => {
    if (idx >= candidates.length) {
      console.log("[PlanGuard Sidecar] All standalone fallback ports exhausted.");
      return;
    }
    const candidatePort = candidates[idx];
    if (candidatePort > 0 && boundPorts.has(candidatePort)) {
      return tryIdx(idx + 1, false);
    }

    const srv = configureHttpServer(http.createServer(requestHandler));
    let finished = false;

    srv.once("error", async (err) => {
      if (finished) return;
      finished = true;
      try { srv.close(); } catch {}
      if (err && err.code === "EADDRINUSE" && candidatePort > 0 && !retriedCurrent) {
        const evictedSelf = await evictStalePlanGuardOnPort(candidatePort);
        if (evictedSelf) {
          setTimeout(() => tryIdx(idx, true), 650);
          return;
        }
      }
      if (err && err.code !== "EADDRINUSE") {
        console.log(`[PlanGuard Sidecar] Port ${candidatePort} notice: ${err.message}`);
      }
      tryIdx(idx + 1, false);
    });

    srv.once("listening", () => {
      if (finished) return;
      finished = true;
      const boundPort = Number(srv.address()?.port || candidatePort);
      if (boundPort > 0) boundPorts.add(boundPort);
      if (typeof onListening === "function") onListening(boundPort, srv);
    });

    try {
      srv.listen(candidatePort, "127.0.0.1");
    } catch {
      if (!finished) {
        finished = true;
        try { srv.close(); } catch {}
        tryIdx(idx + 1, false);
      }
    }
  };

  tryIdx(0, false);
}

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT) {
  const server = configureHttpServer(http.createServer(requestHandler));
  server.on("error", (err) => {
    console.log(`[PlanGuard Sidecar] Port ${PORT} notice: ${err.message}`);
  });
  server.listen(PORT, "127.0.0.1", () => {
    actualPrimaryPort = Number(server.address()?.port || PORT);
    boundPorts.add(actualPrimaryPort);
    console.log(`[PlanGuard Sidecar] Listening on http://127.0.0.1:${actualPrimaryPort}`);
  });

  const standaloneCandidates = STANDALONE_CANDIDATE_PORTS.filter((p) => p === 0 || p !== PORT);
  bindServerWithFallback(standaloneCandidates, (boundPort) => {
    actualStandalonePort = boundPort;
    console.log(`[PlanGuard Sidecar] Dual listening on http://127.0.0.1:${boundPort}`);
  });
} else {
  bindServerWithFallback(STANDALONE_CANDIDATE_PORTS, (boundPort) => {
    actualPrimaryPort = boundPort;
    actualStandalonePort = boundPort;
    console.log(`[PlanGuard Sidecar] Standalone listening on http://127.0.0.1:${boundPort}`);
  });
}

let lastObservedAppStorageMtime = 0;
function bindAdditionalPlanGuardPorts(forceScan = false) {
  try {
    let currentMtime = 0;
    try {
      if (fs.existsSync(APP_STORAGE_FILE)) {
        currentMtime = Math.floor(fs.statSync(APP_STORAGE_FILE).mtimeMs);
      }
    } catch {}
    if (!forceScan && currentMtime === lastObservedAppStorageMtime && boundPorts.size > 1) return;
    lastObservedAppStorageMtime = currentMtime;

    if (!fs.existsSync(APP_STORAGE_FILE)) return;
    const rawText = fs.readFileSync(APP_STORAGE_FILE, "utf8");
    const regex = /plan-guard--panel-(\d+)/g;
    const candidatePorts = new Set();
    let match;
    while ((match = regex.exec(rawText)) !== null) {
      const num = Number(match[1]);
      if (num > 1024 && num < 65535) candidatePorts.add(num);
    }

    for (const p of candidatePorts) {
      if (boundPorts.has(p)) continue;
      boundPorts.add(p);
      try {
        const legacyServer = configureHttpServer(http.createServer(requestHandler));
        legacyServer.on("error", () => {
          boundPorts.delete(p);
          try { legacyServer.close(); } catch {}
        });
        legacyServer.listen(p, "127.0.0.1", () => {
          console.log(`[PlanGuard Sidecar] Legacy session port bridged on http://127.0.0.1:${p}`);
        });
      } catch {
        boundPorts.delete(p);
      }
    }
  } catch {}
}

bindAdditionalPlanGuardPorts(true);
setTimeout(() => bindAdditionalPlanGuardPorts(true), 4000);
setInterval(() => bindAdditionalPlanGuardPorts(false), 30000).unref();

setTimeout(async () => {
  try {
    const st = await getUpdaterStatus();
    if (st.updateMode === "off") return;
    if (Date.now() - Number(st.lastCheckedAt || 0) < 6 * 3600 * 1000) return;
    const checked = await checkForPluginUpdate({ force: false });
    if (checked.updateMode === "auto" && checked.hasUpdate && (checked.installMode === "zip" || checked.worktreeClean)) {
      await performPluginUpdate({ onUpdatedRestart: () => setTimeout(() => process.exit(0), 250) });
    }
  } catch {}
}, 8000).unref();
