// Antigravity Plan Guard · 会话级工作区固化、项目名/插件名/文件芯片外部权限自动映射与越界拦截模块
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  WRITE_FILE_TOOLS,
  EXEC_CMD_TOOLS,
  parseToolArg,
  extractTargetFileFromArgs,
  isPureReadOnlyCommand,
  isWhitelistedTarget
} = require("./read-only-audit.cjs");

function resolveHostHomeDir() {
  const normalized = __dirname.replace(/\\/g, "/");
  const geminiIdx = normalized.toLowerCase().indexOf("/.gemini/");
  if (geminiIdx > 0) {
    const candidate = path.normalize(__dirname.slice(0, geminiIdx));
    if (fs.existsSync(candidate)) return candidate;
  }
  return os.homedir();
}

function normalizePathForMatch(str) {
  if (!str || typeof str !== "string") return "";
  let p = str.trim().replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "");
  try { p = decodeURIComponent(p); } catch (_) {}
  p = p.replace(/\\/g, "/").replace(/^([a-zA-Z])%3A/i, "$1:").replace(/^\/([a-zA-Z]:)/, "$1");
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p.toLowerCase();
}

function isPathInsidePrefixes(normTarget, prefixes) {
  if (!normTarget || !Array.isArray(prefixes) || prefixes.length === 0) return false;
  for (const rawPrefix of prefixes) {
    const p = normalizePathForMatch(rawPrefix);
    if (!p) continue;
    if (normTarget === p || normTarget.startsWith(p + "/")) return true;
  }
  return false;
}

function compactPathPrefixes(prefixes) {
  const unique = Array.from(new Set((prefixes || []).map(normalizePathForMatch).filter(Boolean)));
  unique.sort((a, b) => a.length - b.length);
  const compacted = [];
  for (const p of unique) {
    if (!isPathInsidePrefixes(p, compacted)) {
      compacted.push(p);
    }
  }
  return compacted;
}

function createEmptyGrants() {
  return {
    allowMutatingTools: false,
    allowWorkspaceWrite: false,
    externalPathPrefixes: []
  };
}

function mergeGrants(target, source) {
  const t = target || createEmptyGrants();
  const s = source || createEmptyGrants();
  return {
    allowMutatingTools: Boolean(t.allowMutatingTools || s.allowMutatingTools),
    allowWorkspaceWrite: Boolean(t.allowWorkspaceWrite || s.allowWorkspaceWrite),
    externalPathPrefixes: compactPathPrefixes([
      ...(Array.isArray(t.externalPathPrefixes) ? t.externalPathPrefixes : []),
      ...(Array.isArray(s.externalPathPrefixes) ? s.externalPathPrefixes : [])
    ])
  };
}

let _cachedCatalog = null;
function loadKnownProjectCatalog(homeDir) {
  if (_cachedCatalog) return _cachedCatalog;
  const h = homeDir || resolveHostHomeDir();
  const profilesPath = path.join(h, ".gemini", "config", "project-plugin-profiles.json");
  const projectsDir = path.join(h, ".gemini", "config", "projects");
  const pluginsDir = path.join(h, ".gemini", "config", "plugins");
  const projectMap = {};
  const allKnownProjectRoots = [];
  const seenIdRoot = new Set();

  const registerProject = (id, name, rawPaths, aliases = []) => {
    if (!id || id === "__meta__" || id === "__default__") return;
    if (!projectMap[id]) {
      projectMap[id] = { id, name: name || id, paths: [] };
    } else if (name && (!projectMap[id].name || projectMap[id].name === id)) {
      projectMap[id].name = name;
    }
    if (Array.isArray(rawPaths)) {
      for (const rp of rawPaths) {
        const np = normalizePathForMatch(rp);
        if (!np) continue;
        if (!projectMap[id].paths.includes(np)) {
          projectMap[id].paths.push(np);
        }
        const key = id + "::" + np;
        if (!seenIdRoot.has(key)) {
          seenIdRoot.add(key);
          allKnownProjectRoots.push({
            id,
            name: projectMap[id].name,
            root: np,
            aliases: Array.isArray(aliases) ? aliases.map((a) => String(a || "").toLowerCase()).filter(Boolean) : []
          });
        }
      }
    }
  };

  try {
    let profiles = null;
    if (fs.existsSync(profilesPath)) {
      try { profiles = JSON.parse(fs.readFileSync(profilesPath, "utf8")); } catch (_) {}
    }
    if (!profiles && fs.existsSync(profilesPath + ".bak")) {
      try { profiles = JSON.parse(fs.readFileSync(profilesPath + ".bak", "utf8")); } catch (_) {}
    }
    if (profiles && typeof profiles === "object") {
      for (const [k, v] of Object.entries(profiles)) {
        if (k !== "__meta__" && k !== "__default__" && v && typeof v === "object") {
          registerProject(k, v.name || k, v.paths);
        }
      }
    }
  } catch (_) {}

  try {
    if (fs.existsSync(projectsDir)) {
      const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const pData = JSON.parse(fs.readFileSync(path.join(projectsDir, f), "utf8"));
          const id = pData.id || f.replace(/\.json$/, "");
          const name = pData.name || pData.title || id;
          const paths = [];
          if (Array.isArray(pData.projectResources)) {
            for (const r of pData.projectResources) {
              if (typeof r === "string") paths.push(r);
              else if (r && (r.uri || r.path || r.resourceUri)) paths.push(r.uri || r.path || r.resourceUri);
            }
          }
          if (Array.isArray(pData.paths)) paths.push(...pData.paths);
          registerProject(id, name, paths);
        } catch (_) {}
      }
    }
  } catch (_) {}

  // 自动注册 ~/.gemini/config/plugins 下所有已安装插件目录，支持仅凭插件名（如 antigravity-relay / plan-guard）免路径映射授权
  try {
    if (fs.existsSync(pluginsDir)) {
      registerProject("plugin-root:plugins", "plugins", [pluginsDir], ["plugins", "全局插件目录", "插件目录"]);
      const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const pRoot = path.join(pluginsDir, ent.name);
        let dispName = ent.name;
        const pjPath = path.join(pRoot, "plugin.json");
        if (fs.existsSync(pjPath)) {
          try {
            const pj = JSON.parse(fs.readFileSync(pjPath, "utf8"));
            if (pj && pj.displayName) dispName = pj.displayName;
          } catch (_) {}
        }
        registerProject("plugin:" + ent.name, dispName, [pRoot], [ent.name, dispName]);
      }
    }
  } catch (_) {}

  // 自动扫描已知工作区的父级聚合目录（如 D:\Visual Studio 下的兄弟项目），支持按项目文件夹名直接映射
  try {
    const parentDirs = new Set();
    for (const item of [...allKnownProjectRoots]) {
      if (item.id && item.id.startsWith("plugin")) continue;
      const pDir = path.posix.dirname(item.root);
      if (pDir && !/^[a-z]:$/i.test(pDir) && pDir.split("/").length >= 2) {
        parentDirs.add(pDir);
      }
    }
    for (const pDir of parentDirs) {
      if (!fs.existsSync(pDir)) continue;
      const entries = fs.readdirSync(pDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const childRoot = pDir + "/" + ent.name;
        registerProject("sibling:" + ent.name.toLowerCase(), ent.name, [childRoot], [ent.name]);
      }
    }
  } catch (_) {}

  _cachedCatalog = { projectMap, allKnownProjectRoots };
  return _cachedCatalog;
}

function extractConvId(payload, rawTranscriptPath) {
  let convId = String(
    (payload && (payload.conversationId || payload.conversation_id || payload.trajectoryId || payload.trajectory_id || payload.cascadeId)) || ""
  ).trim();
  if (!convId) {
    const tPath = rawTranscriptPath || (payload && (payload.transcriptPath || payload.transcript_path)) || "";
    if (tPath) {
      const m = String(tPath).replace(/\\/g, "/").match(/\/brain\/([0-9a-f-]{36})\//i);
      if (m && m[1]) convId = m[1];
    }
  }
  return convId;
}

function promoteToCoarseExternalPrefix(normTarget, workspaceRoots, catalog, homeDir) {
  if (!normTarget) return "";
  if (isWhitelistedTarget(normTarget)) return "";
  if (isPathInsidePrefixes(normTarget, workspaceRoots)) return "";

  const normHome = normalizePathForMatch(homeDir || resolveHostHomeDir());

  let bestKnownRoot = "";
  for (const item of (catalog && catalog.allKnownProjectRoots) || []) {
    if (!item || !item.root || item.id === "plugin-root:plugins") continue;
    if (isPathInsidePrefixes(item.root, workspaceRoots)) continue;
    const wrapsCurrentWorkspace = (workspaceRoots || []).some((w) => w === item.root || w.startsWith(item.root + "/"));
    if (wrapsCurrentWorkspace) continue;
    if (normTarget === item.root || normTarget.startsWith(item.root + "/")) {
      if (item.root.length > bestKnownRoot.length) {
        bestKnownRoot = item.root;
      }
    }
  }
  if (bestKnownRoot) return bestKnownRoot;

  const pluginsRoot = normHome ? normHome + "/.gemini/config/plugins" : "";
  if (pluginsRoot && normTarget.startsWith(pluginsRoot + "/") && !isPathInsidePrefixes(pluginsRoot, workspaceRoots)) {
    const rest = normTarget.slice(pluginsRoot.length + 1);
    const seg = rest.split("/")[0];
    if (seg) return pluginsRoot + "/" + seg;
  }

  let isDir = false;
  try {
    if (fs.existsSync(normTarget) && fs.statSync(normTarget).isDirectory()) {
      isDir = true;
    }
  } catch (_) {}

  const base = path.posix.basename(normTarget);
  const looksLikeFile = !isDir && /\.[a-z0-9]{1,8}$/i.test(base);
  if (looksLikeFile) {
    const parentDir = path.posix.dirname(normTarget);
    const isDriveRoot = /^[a-z]:$/i.test(parentDir);
    const isHomeRoot = normHome && parentDir === normHome;
    if (parentDir && parentDir !== "." && !isDriveRoot && !isHomeRoot) {
      return parentDir;
    }
  }
  return normTarget;
}

function cleanCandidatePathToken(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.trim();
  s = s.replace(/#L\d+(?:-L?\d+)?$/i, "");
  s = s.replace(/[),.;:!?'"`\]>]+$/g, "");
  return s.trim();
}

function extractScopeGrantsFromPlan(planTexts, workspaceRoots, homeDir) {
  const h = homeDir || resolveHostHomeDir();
  const normHome = normalizePathForMatch(h);
  const catalog = loadKnownProjectCatalog(h);
  const combinedText = (Array.isArray(planTexts) ? planTexts : [planTexts])
    .filter((t) => typeof t === "string" && t.length > 0)
    .join("\n");

  const rawCandidates = [];

  // 1. 提取 file:/// URI（含聊天正文和方案中的 [file](file:///...) 芯片）
  const fileUriRegex = /file:\/\/\/[^\s"'`<>|)\]]+/gi;
  let m;
  while ((m = fileUriRegex.exec(combinedText)) !== null) {
    rawCandidates.push(cleanCandidatePathToken(m[0]));
  }

  // 2. 提取带引号与不带引号的 Windows 盘符路径
  const quotedDriveRegex = /["'`(]([a-zA-Z]:[\\/][^"'`\r\n<>|)]+)["'`)]/g;
  while ((m = quotedDriveRegex.exec(combinedText)) !== null) {
    rawCandidates.push(cleanCandidatePathToken(m[1]));
  }
  const bareDriveRegex = /\b([a-zA-Z]:[\\/][^\s"'`<>|)\]]+)/g;
  while ((m = bareDriveRegex.exec(combinedText)) !== null) {
    rawCandidates.push(cleanCandidatePathToken(m[1]));
  }

  // 3. 提取 ~/ 或 $env:USERPROFILE / %USERPROFILE% 相对主目录路径
  if (normHome) {
    const homeRelRegex = /(?:~|\$env:USERPROFILE|%USERPROFILE%)[\\/]([^\s"'`<>|)\]]+)/gi;
    while ((m = homeRelRegex.exec(combinedText)) !== null) {
      rawCandidates.push(normHome + "/" + cleanCandidatePathToken(m[1]));
    }
  }

  // 4. 识别方案中直接提及的已知外部项目名、插件名或别名（AI 仅写项目名/插件名即可自动获批外部目录权限）
  const lowerText = combinedText.toLowerCase();
  for (const item of catalog.allKnownProjectRoots) {
    if (!item || !item.root) continue;
    if (isPathInsidePrefixes(item.root, workspaceRoots)) continue;
    const wrapsCurrentWorkspace = (workspaceRoots || []).some((w) => w === item.root || w.startsWith(item.root + "/"));
    if (wrapsCurrentWorkspace) continue;

    const baseName = path.posix.basename(item.root);
    const idToken = String(item.id || "").replace(/^(plugin:|sibling:|plugin-root:)/, "").toLowerCase();
    const nameToken = String(item.name || "").toLowerCase();
    const aliasMatched = Array.isArray(item.aliases) && item.aliases.some((a) => a.length >= 3 && lowerText.includes(a));
    if (
      aliasMatched ||
      (baseName && baseName.length >= 3 && lowerText.includes(baseName)) ||
      (idToken && idToken.length >= 3 && lowerText.includes(idToken)) ||
      (nameToken && nameToken.length >= 2 && lowerText.includes(nameToken))
    ) {
      rawCandidates.push(item.root);
    }
  }

  const externalPrefixes = [];
  for (const cand of rawCandidates) {
    const norm = normalizePathForMatch(cand);
    if (!norm || !/^[a-z]:\//i.test(norm)) continue;
    if (isWhitelistedTarget(norm)) continue;
    if (isPathInsidePrefixes(norm, workspaceRoots)) continue;
    const promoted = promoteToCoarseExternalPrefix(norm, workspaceRoots, catalog, h);
    if (promoted) {
      externalPrefixes.push(promoted);
    }
  }

  return {
    allowMutatingTools: true,
    allowWorkspaceWrite: true,
    externalPathPrefixes: compactPathPrefixes(externalPrefixes)
  };
}

function collectAskQuestionTexts(toolCalls, assistantContent) {
  const texts = [];
  if (typeof assistantContent === "string" && assistantContent.trim()) {
    texts.push(assistantContent.trim());
  }
  if (!Array.isArray(toolCalls)) return texts;
  for (const tc of toolCalls) {
    if (!tc || tc.name !== "ask_question" || !tc.args) continue;
    const qs = parseToolArg(tc.args.questions);
    if (Array.isArray(qs)) {
      for (const q of qs) {
        if (q && typeof q.question === "string" && q.question.trim()) {
          texts.push(q.question.trim());
        }
      }
    } else if (typeof tc.args.questions === "string") {
      texts.push(tc.args.questions);
    }
  }
  return texts;
}

function readCurrentConversationPlanArtifact(rawTranscriptPath, shouldIncludeArtifact) {
  if (!shouldIncludeArtifact || !rawTranscriptPath) return "";
  try {
    const norm = String(rawTranscriptPath).replace(/\\/g, "/");
    const m = norm.match(/^(.*?\/brain\/[0-9a-f-]{36})\//i);
    if (m && m[1]) {
      const planPath = path.join(m[1], "implementation_plan.md");
      if (fs.existsSync(planPath)) {
        return fs.readFileSync(planPath, "utf8");
      }
    }
  } catch (_) {}
  return "";
}

function isBenignSystemOrRuntimePath(normPath, homeDir) {
  if (!normPath) return true;
  if (isWhitelistedTarget(normPath)) return true;
  const normHome = normalizePathForMatch(homeDir || resolveHostHomeDir());
  const normTmp = normalizePathForMatch(os.tmpdir());
  if (normTmp && (normPath === normTmp || normPath.startsWith(normTmp + "/"))) return true;
  if (
    normPath.startsWith("c:/windows/") ||
    normPath === "c:/windows" ||
    normPath.startsWith("c:/program files/") ||
    normPath.startsWith("c:/program files (x86)/") ||
    normPath.includes("/appdata/local/temp") ||
    normPath.includes("/appdata/local/programs/") ||
    normPath.includes("/.gemini/antigravity/brain/")
  ) {
    return true;
  }
  if (normHome) {
    if (
      normPath.startsWith(normHome + "/.cargo/bin") ||
      normPath.startsWith(normHome + "/.rustup") ||
      normPath.startsWith(normHome + "/scoop/") ||
      normPath.startsWith(normHome + "/nvm/")
    ) {
      return true;
    }
  }
  return false;
}

function extractCommandTargetPaths(cmd, homeDir) {
  if (!cmd || typeof cmd !== "string") return [];
  const h = homeDir || resolveHostHomeDir();
  const normHome = normalizePathForMatch(h);
  const candidates = [];

  const quotedDriveRegex = /["']([a-zA-Z]:[\\/][^"'\r\n<>|]+)["']/g;
  let m;
  while ((m = quotedDriveRegex.exec(cmd)) !== null) {
    candidates.push(cleanCandidatePathToken(m[1]));
  }

  const unquotedCmd = cmd.replace(quotedDriveRegex, " ");
  const bareDriveRegex = /\b([a-zA-Z]:[\\/][^\s"'`<>|;)]+)/g;
  while ((m = bareDriveRegex.exec(unquotedCmd)) !== null) {
    candidates.push(cleanCandidatePathToken(m[1]));
  }

  if (normHome) {
    const homeRelRegex = /(?:~|\$env:USERPROFILE|%USERPROFILE%)[\\/]([^\s"'`<>|;)]+)/gi;
    while ((m = homeRelRegex.exec(cmd)) !== null) {
      candidates.push(normHome + "/" + cleanCandidatePathToken(m[1]));
    }
  }

  const results = [];
  for (const c of candidates) {
    const norm = normalizePathForMatch(c);
    if (!norm || !/^[a-z]:\//i.test(norm)) continue;
    if (isBenignSystemOrRuntimePath(norm, h)) continue;
    if (!results.includes(norm)) results.push(norm);
  }
  return results;
}

function verifyToolCallAgainstApprovedGrants(toolName, args, workspaceRoots, effectiveGrants, homeDir, userLang) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
  const grants = effectiveGrants || createEmptyGrants();
  const extPrefixes = Array.isArray(grants.externalPathPrefixes) ? grants.externalPathPrefixes : [];

  if (WRITE_FILE_TOOLS.has(toolName)) {
    const rawTarget = extractTargetFileFromArgs(args);
    if (!rawTarget || isWhitelistedTarget(rawTarget)) {
      return { allowed: true };
    }
    const normTarget = normalizePathForMatch(rawTarget);
    if (roots.length > 0 && normTarget && /^[a-z]:\//i.test(normTarget)) {
      const inWorkspace = isPathInsidePrefixes(normTarget, roots);
      const inApprovedExternal = isPathInsidePrefixes(normTarget, extPrefixes);
      if (!inWorkspace && !inApprovedExternal) {
        const wsLabel = roots.join(", ");
        const extLabel = extPrefixes.length > 0 ? extPrefixes.join(", ") : (userLang === "zh" ? "（无）" : "(none)");
        return {
          allowed: false,
          reason: userLang === "zh"
            ? "【方案门禁拦截 · 工作区外未申报路径修改】目标文件 \"" + rawTarget + "\" 位于当前会话固化的工作区（" + wsLabel + "）之外，且不在本轮方案已申请获批的工作区外路径范围（" + extLabel + "）内！若需修改工作区外的内容，请先在同一回合输出聊天正文解释（content），并调用 ask_question 在方案中写明要修改哪些工作区外的项目名或插件名（严禁在弹窗中裸写详细盘符路径，后台会自动从项目名/插件名/文件芯片映射该目录权限），待用户确认后再执行修改。"
            : "[Plan Guard Intercept | Undeclared Out-of-Workspace Modification] Target file \"" + rawTarget + "\" is outside the conversation's locked workspace (" + wsLabel + ") and is not covered by the approved out-of-workspace path prefixes (" + extLabel + ")! To modify out-of-workspace files, first output chat explanation (content) and call ask_question to state which external project or plugin name will be modified (do NOT write raw full filesystem paths in the popup; background automatically resolves project/plugin names and file chips), and wait for user approval."
        };
      }
    }
    return { allowed: true };
  }

  if (EXEC_CMD_TOOLS.has(toolName)) {
    const cmd = String(args.CommandLine || args.command || "").trim();
    if (!cmd || isPureReadOnlyCommand(cmd)) {
      return { allowed: true };
    }
    if (roots.length > 0) {
      const targetPaths = extractCommandTargetPaths(cmd, homeDir);
      for (const tp of targetPaths) {
        const inWorkspace = isPathInsidePrefixes(tp, roots);
        const inApprovedExternal = isPathInsidePrefixes(tp, extPrefixes);
        if (!inWorkspace && !inApprovedExternal) {
          const wsLabel = roots.join(", ");
          const extLabel = extPrefixes.length > 0 ? extPrefixes.join(", ") : (userLang === "zh" ? "（无）" : "(none)");
          return {
            allowed: false,
            reason: userLang === "zh"
              ? "【方案门禁拦截 · 终端命令涉及未申报的工作区外路径】检测到非只读终端命令操作了工作区（" + wsLabel + "）之外且未在本轮方案中申请获批的路径 \"" + tp + "\"（已批准外部范围：" + extLabel + "）！若需跨工作区执行同步、写入或提交，请先在聊天正文说明并通过 ask_question 写明该外部项目名/插件名申请权限后再执行。"
              : "[Plan Guard Intercept | Terminal Command Targets Undeclared External Path] Mutating command references path \"" + tp + "\" outside the locked workspace (" + wsLabel + ") and outside approved external prefixes (" + extLabel + ")! Please state the external project/plugin name in ask_question and obtain user approval before executing."
          };
        }
      }
    }
    return { allowed: true };
  }

  return { allowed: true };
}

module.exports = {
  resolveHostHomeDir,
  normalizePathForMatch,
  isPathInsidePrefixes,
  compactPathPrefixes,
  createEmptyGrants,
  mergeGrants,
  loadKnownProjectCatalog,
  extractConvId,
  promoteToCoarseExternalPrefix,
  cleanCandidatePathToken,
  extractScopeGrantsFromPlan,
  collectAskQuestionTexts,
  readCurrentConversationPlanArtifact,
  isBenignSystemOrRuntimePath,
  extractCommandTargetPaths,
  verifyToolCallAgainstApprovedGrants
};
