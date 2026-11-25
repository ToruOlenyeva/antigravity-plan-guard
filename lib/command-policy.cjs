// Antigravity Plan Guard · 终端命令白名单/黑名单统一规则引擎与独立配置原子持久化模块
const fs = require("fs");
const path = require("path");
const os = require("os");

const BUILTIN_READONLY_EXAMPLES = [
  "git status / log / diff / branch / show",
  "node -c / --check",
  "dir / ls / cat / head / tail / grep / findstr",
  "cargo check / npm test / npm run test:docs",
  "ssh 只读巡检 (ps, df, ls, docker ps, dpkg -l, opkg list-installed)"
];

const DEFAULT_BLACKLIST_PATTERNS = [
  "rm -rf",
  "del /s",
  "rmdir /s",
  "git push --force",
  "git reset --hard",
  "docker rm",
  "kubectl delete",
  "shutdown",
  "reboot",
  "format"
];

function resolveHostHomeDir() {
  const realEnv = String(process.env.AGY_REAL_USERPROFILE || "").trim();
  if (realEnv && fs.existsSync(realEnv)) return path.normalize(realEnv);
  const normalized = __dirname.replace(/\\/g, "/");
  const geminiIdx = normalized.toLowerCase().indexOf("/.gemini/");
  if (geminiIdx > 0) {
    const candidate = path.normalize(__dirname.slice(0, geminiIdx));
    if (fs.existsSync(candidate)) return candidate;
  }
  return os.homedir();
}

function getRulesFilePath() {
  const envOverride = String(process.env.PLAN_GUARD_RULES_FILE || "").trim();
  if (envOverride) return path.normalize(envOverride);
  return path.join(resolveHostHomeDir(), ".gemini", "config", "plan-guard-rules.json");
}

function makeDefaultBlacklistEntries() {
  return DEFAULT_BLACKLIST_PATTERNS.map((pattern, idx) => ({
    id: `bl-${idx + 1}`,
    pattern,
    enabled: true
  }));
}

function getDefaultPolicyConfig() {
  return {
    version: 1,
    mode: "whitelist",
    includeBuiltinReadOnly: true,
    whitelist: [],
    blacklist: makeDefaultBlacklistEntries(),
    updatedAt: 0
  };
}

function normalizeRuleList(rawList, fallbackList, idPrefix) {
  const source = Array.isArray(rawList) ? rawList : fallbackList;
  const result = [];
  const seenPatterns = new Set();

  for (let i = 0; i < source.length; i++) {
    const entry = source[i];
    let rawPattern = "";
    let enabled = true;
    let rawId = "";

    if (typeof entry === "string") {
      rawPattern = entry;
    } else if (entry && typeof entry === "object") {
      rawPattern = String(entry.pattern || "");
      enabled = entry.enabled !== false;
      rawId = String(entry.id || "").trim();
    }

    const pattern = rawPattern.trim();
    if (!pattern) continue;
    const dedupKey = pattern.toLowerCase();
    if (seenPatterns.has(dedupKey)) continue;
    seenPatterns.add(dedupKey);

    result.push({
      id: rawId || `${idPrefix}-${result.length + 1}`,
      pattern,
      enabled
    });
  }
  return result;
}

function normalizePolicyConfig(raw) {
  const defaults = getDefaultPolicyConfig();
  if (!raw || typeof raw !== "object") return defaults;
  return {
    version: 1,
    mode: raw.mode === "blacklist" ? "blacklist" : "whitelist",
    includeBuiltinReadOnly: raw.includeBuiltinReadOnly !== false,
    whitelist: normalizeRuleList(raw.whitelist, [], "wl"),
    blacklist: raw.blacklist === undefined
      ? makeDefaultBlacklistEntries()
      : normalizeRuleList(raw.blacklist, [], "bl"),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0
  };
}

function tryReadJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const txt = fs.readFileSync(filePath, "utf8");
      if (txt && txt.trim()) {
        return JSON.parse(txt);
      }
    } catch (_) {}
  }
  return null;
}

function readCommandPolicyConfig(filePath) {
  const targetPath = filePath || getRulesFilePath();
  const parsed = tryReadJsonFile(targetPath) || tryReadJsonFile(targetPath + ".bak");
  return normalizePolicyConfig(parsed);
}

function toComparableJson(cfg) {
  return JSON.stringify({
    version: 1,
    mode: cfg.mode,
    includeBuiltinReadOnly: cfg.includeBuiltinReadOnly,
    whitelist: cfg.whitelist,
    blacklist: cfg.blacklist
  });
}

function writeCommandPolicyConfig(nextConfig, filePath) {
  const targetPath = filePath || getRulesFilePath();
  const normalized = normalizePolicyConfig(nextConfig);
  const existing = tryReadJsonFile(targetPath);
  if (existing && toComparableJson(normalizePolicyConfig(existing)) === toComparableJson(normalized)) {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(targetPath).mtimeMs; } catch (_) {}
    return {
      config: normalizePolicyConfig(existing),
      written: false,
      mtimeMs
    };
  }

  normalized.updatedAt = Date.now();
  const serialized = JSON.stringify(normalized, null, 2) + "\n";
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  const suffix = `${process.pid}.${Date.now()}`;
  const tmpPath = `${targetPath}.tmp.${suffix}`;
  fs.writeFileSync(tmpPath, serialized, "utf8");
  fs.renameSync(tmpPath, targetPath);

  const bakPath = `${targetPath}.bak`;
  const tmpBak = `${bakPath}.tmp.${suffix}`;
  try {
    fs.writeFileSync(tmpBak, serialized, "utf8");
    fs.renameSync(tmpBak, bakPath);
  } catch (_) {
    try { fs.unlinkSync(tmpBak); } catch (_) {}
  }

  let mtimeMs = normalized.updatedAt;
  try { mtimeMs = fs.statSync(targetPath).mtimeMs; } catch (_) {}
  return { config: normalized, written: true, mtimeMs };
}

function splitCommandSegments(cmd) {
  if (!cmd || typeof cmd !== "string") return [];
  const segments = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1] || "";

    if (inSingle) {
      cur += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      cur += ch;
      if (ch === "\\" && (next === "\"" || next === "\\")) {
        cur += next;
        i++;
      } else if (ch === "\"") {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      cur += ch;
      continue;
    }
    if (ch === "\"") {
      inDouble = true;
      cur += ch;
      continue;
    }

    if (ch === "\n" || ch === "\r" || ch === ";") {
      if (cur.trim()) segments.push(cur.trim());
      cur = "";
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (cur.trim()) segments.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    if (ch === "|") {
      if (cur.trim()) segments.push(cur.trim());
      cur = "";
      continue;
    }

    cur += ch;
  }

  if (cur.trim()) segments.push(cur.trim());
  return segments;
}

function hasCommandSubstitution(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1] || "";

    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && next) {
        i++;
        continue;
      }
      if (ch === "\"") {
        inDouble = false;
        continue;
      }
    } else if (ch === "'") {
      inSingle = true;
      continue;
    } else if (ch === "\"") {
      inDouble = true;
      continue;
    }

    if (ch === "$" && next === "(") return true;
    if (ch === "`" && !inSingle) {
      // Backtick command substitution in shells (when paired on non-empty inner text)
      const closeIdx = cmd.indexOf("`", i + 1);
      if (closeIdx > i + 1) return true;
    }
  }
  return false;
}

function hasWriteRedirection(seg) {
  if (!seg || typeof seg !== "string") return false;
  const cNoStdErr = seg
    .toLowerCase()
    .replace(/\b2>\s*\/dev\/null\b/g, "")
    .replace(/\b2>&1\b/g, "");
  return (
    cNoStdErr.indexOf(">") !== -1 ||
    /\b(out-file|set-content|add-content)\b/i.test(cNoStdErr)
  );
}

function parseRegexRule(cleanRule) {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(cleanRule);
  if (!m) return null;
  const safeFlags = m[2].replace(/[gy]/g, "");
  try {
    return new RegExp(m[1], safeFlags);
  } catch (_) {
    return null;
  }
}

function escapeRegexLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildGlobRegex(cleanRule) {
  const parts = cleanRule.replace(/\s+/g, " ").trim().split("*");
  let regexSrc = "";
  for (let i = 0; i < parts.length; i++) {
    regexSrc += escapeRegexLiteral(parts[i]);
    if (i < parts.length - 1) regexSrc += ".*";
  }
  regexSrc = regexSrc.replace(/ \.\* /g, "(?: .* | )");
  try {
    return new RegExp(`^${regexSrc}(?:\\s|$)`, "i");
  } catch (_) {
    return null;
  }
}

function stripLeadingCommandWrappers(normSeg) {
  let s = normSeg;
  for (let i = 0; i < 4; i++) {
    const next = s
      .replace(/^(?:sudo|command|nohup|env)(?:\s+-\S+(?:\s+\S+)?)?\s+/i, "")
      .replace(/^wsl(?:\s+(?:-d|-u|--distribution|--user)\s+\S+|\s+--)?\s+/i, "")
      .replace(/^ssh\s+(?:-[a-z0-9]+\s+\S+\s+)*\S+\s+/i, "")
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

function prefixBoundaryMatch(normText, normRule) {
  return normText === normRule || normText.startsWith(normRule + " ");
}

function isFlagToken(tok) {
  return /^-/.test(tok) || /^\/[a-z]/i.test(tok);
}

function matchBlacklistFlagReordered(normSeg, normRule) {
  const ruleTokens = normRule.split(" ").filter(Boolean);
  if (ruleTokens.length < 2) return false;
  const firstFlagIdx = ruleTokens.findIndex(isFlagToken);
  if (firstFlagIdx <= 0) return false;

  const baseCmdTokens = ruleTokens.slice(0, firstFlagIdx);
  const requiredFlags = ruleTokens.slice(firstFlagIdx);
  const segTokens = normSeg.split(" ").filter(Boolean);
  if (segTokens.length < ruleTokens.length) return false;

  for (let i = 0; i < baseCmdTokens.length; i++) {
    if (segTokens[i] !== baseCmdTokens[i]) return false;
  }
  const segRest = segTokens.slice(baseCmdTokens.length);
  return requiredFlags.every((req) => segRest.includes(req));
}

function matchSegmentAgainstRule(segment, pattern, mode) {
  const segRaw = String(segment || "").trim();
  const cleanRule = String(pattern || "").trim();
  if (!segRaw || !cleanRule) return false;

  // 1. Regex rule (/pattern/flags)
  if (cleanRule.startsWith("/") && /^\/.+\/[gimsuy]*$/.test(cleanRule)) {
    const re = parseRegexRule(cleanRule);
    if (!re) return false;
    return re.test(segRaw);
  }

  const normSeg = segRaw.replace(/\s+/g, " ").trim().toLowerCase();
  const normRule = cleanRule.replace(/\s+/g, " ").trim().toLowerCase();

  // In whitelist mode, reject commands with write redirection unless rule explicitly includes it
  if (mode !== "blacklist" && hasWriteRedirection(segRaw) && !hasWriteRedirection(cleanRule)) {
    return false;
  }

  // 2. Glob rule (* wildcard)
  if (cleanRule.includes("*")) {
    const globRe = buildGlobRegex(cleanRule);
    if (!globRe) return false;
    if (globRe.test(normSeg)) return true;
    if (mode === "blacklist") {
      const unwrapped = stripLeadingCommandWrappers(normSeg);
      if (unwrapped && unwrapped !== normSeg && globRe.test(unwrapped)) return true;
    }
    return false;
  }

  // 3. Plain command rule
  if (mode !== "blacklist") {
    return prefixBoundaryMatch(normSeg, normRule);
  }

  if (prefixBoundaryMatch(normSeg, normRule) || matchBlacklistFlagReordered(normSeg, normRule)) {
    return true;
  }
  const unwrapped = stripLeadingCommandWrappers(normSeg);
  if (unwrapped && unwrapped !== normSeg) {
    if (prefixBoundaryMatch(unwrapped, normRule) || matchBlacklistFlagReordered(unwrapped, normRule)) {
      return true;
    }
  }
  return false;
}

function evaluateCommandPolicy(cmd, builtinReadOnlyFn, configOverride) {
  const config = configOverride ? normalizePolicyConfig(configOverride) : readCommandPolicyConfig();
  const rawCmd = String(cmd || "").trim();
  const segments = splitCommandSegments(rawCmd);

  if (!rawCmd || segments.length === 0) {
    return {
      decision: "gate",
      mode: config.mode,
      reason: "empty_command",
      matchedRule: "",
      matchedRules: [],
      segments: []
    };
  }

  if (config.mode === "blacklist") {
    const enabledBlacklist = config.blacklist.filter((r) => r.enabled !== false);
    const matchedRules = [];
    const segmentDetails = [];

    for (const seg of segments) {
      let segMatch = "";
      for (const rule of enabledBlacklist) {
        if (matchSegmentAgainstRule(seg, rule.pattern, "blacklist")) {
          segMatch = rule.pattern;
          if (!matchedRules.includes(rule.pattern)) matchedRules.push(rule.pattern);
          break;
        }
      }
      segmentDetails.push({
        text: seg,
        decision: segMatch ? "gate" : "allow",
        reason: segMatch ? "matched_blacklist" : "not_in_blacklist",
        matchedRule: segMatch
      });
    }

    // Also test full raw command for regex rules spanning operators
    for (const rule of enabledBlacklist) {
      if (rule.pattern.startsWith("/") && matchSegmentAgainstRule(rawCmd, rule.pattern, "blacklist")) {
        if (!matchedRules.includes(rule.pattern)) matchedRules.push(rule.pattern);
      }
    }

    if (matchedRules.length > 0) {
      return {
        decision: "gate",
        mode: "blacklist",
        reason: "matched_blacklist",
        matchedRule: matchedRules[0],
        matchedRules,
        segments: segmentDetails
      };
    }

    return {
      decision: "allow",
      mode: "blacklist",
      reason: "not_in_blacklist",
      matchedRule: "",
      matchedRules: [],
      segments: segmentDetails
    };
  }

  // Whitelist mode
  const enabledWhitelist = config.whitelist.filter((r) => r.enabled !== false);

  if (hasCommandSubstitution(rawCmd)) {
    const fullRegexHit = enabledWhitelist.find(
      (r) => r.pattern.startsWith("/") && matchSegmentAgainstRule(rawCmd, r.pattern, "whitelist")
    );
    if (!fullRegexHit) {
      return {
        decision: "gate",
        mode: "whitelist",
        reason: "command_substitution",
        matchedRule: "",
        matchedRules: [],
        segments: segments.map((s) => ({
          text: s,
          decision: "gate",
          reason: "command_substitution",
          matchedRule: ""
        }))
      };
    }
    return {
      decision: "allow",
      mode: "whitelist",
      reason: "matched_whitelist",
      matchedRule: fullRegexHit.pattern,
      matchedRules: [fullRegexHit.pattern],
      segments: [{ text: rawCmd, decision: "allow", reason: "matched_whitelist", matchedRule: fullRegexHit.pattern }]
    };
  }

  const matchedRules = [];
  const segmentDetails = [];
  let allAllowed = true;

  for (const seg of segments) {
    let matchedRule = "";
    let reason = "not_in_whitelist";
    let allowed = false;

    for (const rule of enabledWhitelist) {
      if (matchSegmentAgainstRule(seg, rule.pattern, "whitelist")) {
        allowed = true;
        matchedRule = rule.pattern;
        reason = "matched_whitelist";
        if (!matchedRules.includes(rule.pattern)) matchedRules.push(rule.pattern);
        break;
      }
    }

    if (!allowed && config.includeBuiltinReadOnly && typeof builtinReadOnlyFn === "function" && builtinReadOnlyFn(seg)) {
      allowed = true;
      reason = "builtin_readonly";
    }

    if (!allowed) allAllowed = false;
    segmentDetails.push({
      text: seg,
      decision: allowed ? "allow" : "gate",
      reason,
      matchedRule
    });
  }

  return {
    decision: allAllowed ? "allow" : "gate",
    mode: "whitelist",
    reason: allAllowed ? (matchedRules.length > 0 ? "matched_whitelist" : "builtin_readonly") : "not_in_whitelist",
    matchedRule: matchedRules[0] || "",
    matchedRules,
    segments: segmentDetails
  };
}

module.exports = {
  BUILTIN_READONLY_EXAMPLES,
  DEFAULT_BLACKLIST_PATTERNS,
  resolveHostHomeDir,
  getRulesFilePath,
  getDefaultPolicyConfig,
  normalizePolicyConfig,
  readCommandPolicyConfig,
  writeCommandPolicyConfig,
  splitCommandSegments,
  hasCommandSubstitution,
  hasWriteRedirection,
  matchSegmentAgainstRule,
  evaluateCommandPolicy
};
