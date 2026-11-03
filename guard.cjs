// Antigravity 全局方案审查门禁执行引擎 (plan-guard) · 交互按钮确认架构 (ask_question) + 增量字节游标本轮全放开状态机
const fs = require("fs");
const path = require("path");

function detectUserLang(transcriptPath) {
  if (transcriptPath) {
    try {
      let tPath = transcriptPath;
      if (tPath.endsWith("transcript_full.jsonl")) {
        const compact = tPath.replace("transcript_full.jsonl", "transcript.jsonl");
        if (fs.existsSync(compact)) tPath = compact;
      }
      if (fs.existsSync(tPath)) {
        const fd = fs.openSync(tPath, "r");
        const stats = fs.fstatSync(fd);
        const readSize = Math.min(stats.size, 1048576);
        const buffer = Buffer.alloc(readSize);
        fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
        fs.closeSync(fd);
        const lines = buffer.toString("utf-8").trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const e = JSON.parse(lines[i]);
            if (e.source === "USER_EXPLICIT" || e.type === "USER_INPUT") {
              const text = String(e.content || "");
              if (/[\u4e00-\u9fff]/.test(text)) return "zh";
              if (/[a-zA-Z]/.test(text)) return "en";
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  const sysLocale = (process.env.LANG || process.env.LC_ALL || Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase();
  return sysLocale.startsWith("zh") ? "zh" : "en";
}

function getStatePath(transcriptPath) {
  if (transcriptPath) {
    try {
      const dir = path.dirname(transcriptPath);
      return path.join(dir, "guard-state.json");
    } catch (e) {}
  }
  const os = require("os");
  return path.join(os.tmpdir(), "antigravity-plan-guard-state.json");
}

function createEmptyGrants() {
  return {
    allowMutatingTools: false,
    allowWorkspaceWrite: false,
    externalPathPrefixes: []
  };
}

function createInitialState() {
  return {
    stateVersion: 2,
    approved: false,
    approvedStepIndex: -1,
    lastScannedOffset: 0,
    hasPlanSinceLastReset: false,
    hasAssistantContentSinceLastReset: false,
    currentAskStepFound: false,
    currentAskStepHasContent: false,
    lastResetReason: "initial",
    pendingToolCalls: [],
    pendingStepIndex: -1,
    hasUserInput: false,
    hasParentSenderMessage: false,
    parentConvId: "",
    lockedProjectId: "",
    lockedWorkspaceRoots: [],
    pendingGrants: createEmptyGrants(),
    approvedGrants: createEmptyGrants()
  };
}

function loadState(statePath) {
  try {
    if (statePath && fs.existsSync(statePath)) {
      const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (data && typeof data === "object" && data.stateVersion === 2) {
        return Object.assign(createInitialState(), data);
      }
    }
  } catch (e) {}
  return createInitialState();
}

function saveState(statePath, state) {
  try {
    if (statePath) {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    }
  } catch (e) {}
}

const SAFE_READ_TOOLS = new Set([
  "view_file",
  "view_file_outline",
  "view_code_item",
  "read_file",
  "read_url_content",
  "search_web",
  "list_dir",
  "find_by_name",
  "grep_search",
  "ask_question",
  "send_message",
  "list_resources",
  "read_resource",
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoRead"
]);

const WRITE_FILE_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write_file",
  "edit_file",
  "Write",
  "Edit",
  "MultiEdit"
]);

const EXEC_CMD_TOOLS = new Set([
  "run_command",
  "Bash"
]);

function isModelAgnosticReadOnlyTool(toolName, args = {}) {
  if (!toolName || typeof toolName !== "string") return false;
  if (SAFE_READ_TOOLS.has(toolName)) return true;

  if (toolName === "manage_task") {
    const act = String(parseToolArg(args.Action) || "").toLowerCase();
    if (act === "status" || act === "list") return true;
    return false;
  }

  if (toolName === "manage_subagents") {
    const act = String(parseToolArg(args.Action) || "").toLowerCase();
    if (act === "list") return true;
    return false;
  }

  if (toolName === "call_mcp_tool") {
    const mcpTool = String(parseToolArg(args.ToolName) || "");
    if ((/^(get_|list_|search_|read_|view_|sequentialthinking$)/i.test(mcpTool) || /(^|_)(read|view|get|list|search|find|grep|fetch|inspect|check)(_|$)/i.test(mcpTool)) && !/(write|edit|replace|create|delete|remove|update|run|exec|kill|push|commit|send|merge|fork)/i.test(mcpTool)) {
      return true;
    }
    return false;
  }

  if (WRITE_FILE_TOOLS.has(toolName) || EXEC_CMD_TOOLS.has(toolName) || toolName === "invoke_subagent" || toolName === "define_subagent" || toolName === "schedule") {
    return false;
  }

  // 语义词根兜底：凡以只读动词开头（或带 mcp_<server>_ 前缀的 Eager MCP 只读工具）且不含任何写盘/执行/修改词根的工具，跨模型自动放行
  if (/^(mcp_[\w-]+_)?(read|view|get|list|search|find|grep|fetch|inspect|check)(_|$)/i.test(toolName) && !/(write|edit|replace|create|delete|remove|update|run|exec|kill|push|commit|send|patch|modify)/i.test(toolName)) {
    return true;
  }

  return false;
}

function extractTargetFileFromArgs(args = {}) {
  return String(
    parseToolArg(args.TargetFile) ||
    parseToolArg(args.Path) ||
    parseToolArg(args.file_path) ||
    parseToolArg(args.AbsolutePath) ||
    ""
  );
}

function extractWriteContentFromArgs(args = {}) {
  const parts = [
    args.CodeContent,
    args.ReplacementContent,
    args.Content,
    args.Replacement,
    args.content,
    args.new_string
  ].filter((v) => typeof v === "string" && v.length > 0);

  if (Array.isArray(args.ReplacementChunks)) {
    for (const chunk of args.ReplacementChunks) {
      if (chunk && typeof chunk.ReplacementContent === "string") {
        parts.push(chunk.ReplacementContent);
      }
    }
  }
  return parts.join("\n");
}

function reply(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => { resolve(data); });
  });
}

function parseToolArg(val) {
  if (val === undefined || val === null) return val;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch (e) { return val; }
  }
  return val;
}

function isPureReadOnlyCommand(cmd) {
  if (!cmd) return false;
  const c = cmd.toLowerCase().replace(/[\r\n]/g, " ").trim();
  const cNoStdErr = c.replace(/\b2>\s*\/dev\/null\b/g, "").replace(/\b2>&1\b/g, "");

  // 1. 禁止任何实质文件重定向或写盘行为（已豁免 2>/dev/null 与 2>&1）
  if (cNoStdErr.indexOf(">") !== -1 || cNoStdErr.indexOf("out-file") !== -1 || cNoStdErr.indexOf("set-content") !== -1 || cNoStdErr.indexOf("add-content") !== -1) {
    return false;
  }

  // 2. 远程 SSH 命令严格审计（拦截任何写盘/启停/变更子命令，放行纯只读巡检）
  if (/^ssh(\s|$)/.test(c)) {
    const remoteMutations = /\b(sed\s+-i|tee\b|rm\b|mv\b|cp\b|scp\b|rsync\b|systemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload|edit|set-property)|service\s+\S+\s+(start|stop|restart|reload)|docker\s+(run|rm|rmi|stop|start|restart|kill|pause|unpause|update|build|pull|push|commit|cp|create|network\s+create|network\s+rm|volume\s+create|volume\s+rm|compose\s+up|compose\s+down|compose\s+restart)|qm\s+(start|stop|reboot|reset|shutdown|suspend|resume|destroy|set|clone|migrate|rollback|snapshot|delonestop)|pct\s+(start|stop|reboot|shutdown|destroy|set)|apt\b|apt-get\b|dpkg\s+-(i|r|p|b)|opkg\s+(install|remove|upgrade)|yum\b|dnf\b|apk\s+(add|del)|curl\s+.*(-o|-O|-X\s*(POST|PUT|DELETE|PATCH)|--data|-d)|wget\b|reboot\b|shutdown\b|poweroff\b|init\b|chmod\b|chown\b|chgrp\b|kill\b|pkill\b|killall\b|mkdir\b|touch\b|ln\b|mount\b|umount\b|ufw\s+(enable|disable|allow|deny|delete|reset|reload)|firewall-cmd\s+.*(--add-|--remove-|--change-|--set-|--reload|--complete-reload|--runtime-to-permanent)|iptables\s+.*(-[AIiDRFPZNX]|--append|--insert|--delete|--replace|--flush|--zero|--new-chain|--delete-chain|--policy)|nft\s+(add|insert|replace|create|delete|destroy|flush|rename|reset|-f)|crontab\s+-[er]|useradd\b|userdel\b|usermod\b|passwd\b|visudo\b|dd\b|mkfs\b|fdisk\b|parted\b)/i;
    if (remoteMutations.test(cNoStdErr)) return false;

    const pureRemoteReads = /\b(cat|grep|egrep|fgrep|ls|ps|head|tail|find|which|whereis|type|echo|uptime|top|free|df|du|stat|uname|hostname|id|whoami|ip|ss|netstat|lsof|ping|curl|tcpdump|traceroute|tracepath|dig|nslookup|host|firewall-cmd\s+(--state|--get-|--list-|--query-|--info-|--version)|ufw\s+(status|version)|nft\s+list|iptables\s+(-[LSvnx]|--list|--list-rules)|dpkg\s+-l|opkg\s+list-installed|docker\s+(ps|top|inspect|logs|stats|images|version|info|exec)|qm\s+(status|list|config|guest\s+exec)|pct\s+(status|list|config)|systemctl\s+(status|is-active|is-enabled|list-units|list-unit-files|show)|journalctl)\b/i;
    if (pureRemoteReads.test(cNoStdErr)) return true;

    return false;
  }

  // 3. 本地纯只读查询与语法检查命令白名单（支持 git -C <path> 前缀与 node -c 语法校验）
  const localSafeReads = /^(git\s+(-c\s+("[^"]+"|'[^']+'|\S+)\s+)?(status|log|diff|branch|show)|node\s+(-c|--check)|dir|ls|get-childitem|cat|type|get-content|head|tail|grep|select-string|findstr|npm\s+run\s+test:docs|npm\s+test|cargo\s+check)(\s|$)/i;
  if (localSafeReads.test(cNoStdErr)) return true;

  return false;
}

function isWhitelistedTarget(targetFile) {
  if (!targetFile) return false;
  const tf = String(targetFile).replace(/\\/g, "/").toLowerCase();
  return (
    tf.includes(".gemini/antigravity/brain/") ||
    tf.includes("/brain/") ||
    tf.includes("/scratch/") ||
    tf.endsWith("/implementation_plan.md") ||
    tf === "implementation_plan.md" ||
    tf.endsWith("/walkthrough.md") ||
    tf === "walkthrough.md"
  );
}

function isToolCallGated(tc) {
  if (!tc || !tc.name) return false;
  const name = tc.name;
  const args = tc.args || {};
  if (isModelAgnosticReadOnlyTool(name, args)) return false;
  if (WRITE_FILE_TOOLS.has(name)) {
    const tf = extractTargetFileFromArgs(args);
    if (isWhitelistedTarget(tf)) return false;
  }
  if (EXEC_CMD_TOOLS.has(name)) {
    const cmd = String(parseToolArg(args.CommandLine || args.command) || "").trim();
    if (isPureReadOnlyCommand(cmd)) return false;
  }
  return true;
}

function isUserAuthorized(text) {
  if (!text) return false;
  if (/approved this document|proceed with the implementation|user approved|accepted the plan/i.test(text)) return true;
  let clean = text.replace(/<USER_REQUEST>|<\/USER_REQUEST>|<ADDITIONAL_METADATA>[\s\S]+?<\/ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>[\s\S]+?<\/USER_SETTINGS_CHANGE>/g, "").trim();
  if (clean.startsWith("@[Quote]")) clean = clean.slice(8).trim();
  const pauseSignals = /(先等下|慢着|等等|暂停|别动|不要动|停下|先别|不要改|先不改|等一下|先停|仅讨论|只看方案|先不执行)/;
  if (pauseSignals.test(clean)) return false;
  // 若首句明确表达选择某套方案（如「我想选方案B」），即使后半句附带顺带提问也视为对方案 B 的授权
  if (/^(我想选|我选|选择|采用|就选|就用|选)\s*方案\s*[A-Za-z0-9一二三四]/i.test(clean)) return true;
  if (/[?？]/.test(clean) || /(为什么|怎么|能不能|你可以|难道|是否|有吗|好用吗|对吗|更好|是不是|忘了|没弄)/.test(clean)) return false;
  const standaloneAuth = /^(确认|执行|可以|同意|修吧|改吧|好的|没问题|行|继续|好|ok|yes|proceed|approve|开始|做吧|搞吧|动手|实施)$/i;
  if (standaloneAuth.test(clean)) return true;
  const explicitAction = /^(那就|请|确认|同意|批准|立即)[\s\S]+(修改|修复|执行|添加|改动|重构|写|装|落实|落地)/;
  if (explicitAction.test(clean)) return true;
  return false;
}

function extractAskQuestionPresetOptions(toolCalls) {
  const preset = new Set();
  if (!Array.isArray(toolCalls)) return preset;
  for (const tc of toolCalls) {
    if (!tc || tc.name !== "ask_question" || !tc.args) continue;
    const rawQuestions = tc.args.questions;
    const qs = parseToolArg(rawQuestions);
    if (Array.isArray(qs)) {
      for (const q of qs) {
        if (q && Array.isArray(q.options)) {
          for (const opt of q.options) {
            if (typeof opt === "string" && opt.trim()) {
              preset.add(opt.trim());
            }
          }
        }
      }
    } else if (typeof rawQuestions === "string" && rawQuestions.indexOf('"options"') !== -1) {
      // 兼容 transcript.jsonl 字段超长截断导致 JSON.parse 失败的场景：正则抢救提取 options 数组
      const optBlockRegex = /"options"\s*:\s*\[([\s\S]*?)(?:\]|$)/g;
      let blockMatch;
      while ((blockMatch = optBlockRegex.exec(rawQuestions)) !== null) {
        const strRegex = /"((?:\\.|[^"\\])*)"/g;
        let strMatch;
        while ((strMatch = strRegex.exec(blockMatch[1])) !== null) {
          try {
            const decoded = JSON.parse(`"${strMatch[1]}"`).trim();
            if (decoded) preset.add(decoded);
          } catch (e) {}
        }
      }
    }
  }
  return preset;
}

function evaluateAskQuestionResponse(content, presetOptions) {
  if (!content || typeof content !== "string") return { isAskResponse: false };
  if (content.indexOf("The command exited with code") !== -1 || content.indexOf("File Path:") !== -1) {
    return { isAskResponse: false };
  }
  const match = content.match(/^Created At:[^\r\n]+\r?\nCompleted At:[^\r\n]+\r?\n([\s\S]+)$/);
  if (!match || !match[1]) return { isAskResponse: false };
  const body = match[1].trim();
  if (!/^A\d+:/m.test(body)) return { isAskResponse: false };

  const answerLines = [];
  const regex = /^A\d+:\s*(.*)$/gm;
  let m;
  while ((m = regex.exec(body)) !== null) {
    answerLines.push((m[1] || "").trim());
  }
  if (answerLines.length === 0) return { isAskResponse: false };

  const rejectSignals = /(先等下|慢着|等等|暂停|别动|不要动|停下|先别|不要改|先不改|暂不|取消|拒绝|仅讨论|先看更多细节|^cancel$|^reject$|^no$|^stop$)/i;
  const standardApprovePreset = /^(\(Recommended\)\s*)?(确认执行|确认修改|同意并执行|确认|同意|采用|继续|confirm|approve|proceed|yes)$/i;

  for (const ans of answerLines) {
    if (!ans || /^(skipped|canceled|cancelled)$/i.test(ans)) {
      return { isAskResponse: true, approved: false, isWriteIn: false };
    }
    if (rejectSignals.test(ans)) {
      return { isAskResponse: true, approved: false, isWriteIn: false };
    }
    if (standardApprovePreset.test(ans) || ans.startsWith("(Recommended)")) {
      continue;
    }
    if (!presetOptions || presetOptions.size === 0) {
      return { isAskResponse: true, approved: false, isWriteIn: true };
    }
    if (!presetOptions.has(ans)) {
      const parts = ans.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
      const allPartsInPreset = parts.length > 1 && parts.every((p) => presetOptions.has(p) || p.startsWith("(Recommended)"));
      if (!allPartsInPreset) {
        return { isAskResponse: true, approved: false, isWriteIn: true };
      }
    }
  }

  return { isAskResponse: true, approved: true, isWriteIn: false };
}

function isReadOnlySubagentCall(args) {
  if (!args) return false;
  const isReadOnlyType = (t) => /^(research|explore)$|(-auditor|-reader|-explorer)$/i.test(t);
  // 兼容新版模型单对象结构 ({ TypeName: "research", ... })
  const directType = String(parseToolArg(args.TypeName || args.typeName || args.subagent_type) || "").trim().toLowerCase();
  if (directType) {
    return isReadOnlyType(directType);
  }
  // 兼容旧版模型数组结构 ({ Subagents: [{ TypeName: "research" }] })
  const subs = parseToolArg(args.Subagents);
  if (!Array.isArray(subs) || subs.length === 0) return false;
  return subs.every((s) => {
    const t = String((s && (s.TypeName || s.typeName)) || "").trim().toLowerCase();
    return isReadOnlyType(t);
  });
}

function resolveHostHomeDir() {
  const normalized = __dirname.replace(/\\/g, "/");
  const geminiIdx = normalized.toLowerCase().indexOf("/.gemini/");
  if (geminiIdx > 0) {
    const candidate = path.normalize(__dirname.slice(0, geminiIdx));
    if (fs.existsSync(candidate)) return candidate;
  }
  const os = require("os");
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
  const projectMap = {};
  const allKnownProjectRoots = [];

  const registerProject = (id, name, rawPaths) => {
    if (!id || id === "__meta__" || id === "__default__") return;
    if (!projectMap[id]) {
      projectMap[id] = { id, name: name || id, paths: [] };
    } else if (name && (!projectMap[id].name || projectMap[id].name === id)) {
      projectMap[id].name = name;
    }
    if (Array.isArray(rawPaths)) {
      for (const rp of rawPaths) {
        const np = normalizePathForMatch(rp);
        if (np && !projectMap[id].paths.includes(np)) {
          projectMap[id].paths.push(np);
          allKnownProjectRoots.push({ id, name: projectMap[id].name, root: np });
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

function resolveAndLockWorkspaceRoots(payload, state, statePath, rawTranscriptPath) {
  const homeDir = resolveHostHomeDir();
  const convId = extractConvId(payload, rawTranscriptPath);

  // 1. 若当前会话是子智能体且记录了 parentConvId，直接从父会话 guard-state.json 继承固化的工作区与已批准权限
  const isSubagent = !state.hasUserInput && state.hasParentSenderMessage;
  if (isSubagent && state.parentConvId) {
    try {
      const parentStatePath = path.join(homeDir, ".gemini", "antigravity", "brain", state.parentConvId, ".system_generated", "logs", "guard-state.json");
      if (fs.existsSync(parentStatePath)) {
        const parentState = loadState(parentStatePath);
        let changed = false;
        if (parentState.lockedProjectId && state.lockedProjectId !== parentState.lockedProjectId) {
          state.lockedProjectId = parentState.lockedProjectId;
          changed = true;
        }
        if (Array.isArray(parentState.lockedWorkspaceRoots) && parentState.lockedWorkspaceRoots.length > 0) {
          const mergedRoots = compactPathPrefixes([...(state.lockedWorkspaceRoots || []), ...parentState.lockedWorkspaceRoots]);
          if (mergedRoots.length !== (state.lockedWorkspaceRoots || []).length) {
            state.lockedWorkspaceRoots = mergedRoots;
            changed = true;
          }
        }
        const mergedApproved = mergeGrants(state.approvedGrants, mergeGrants(parentState.approvedGrants, parentState.pendingGrants));
        if (
          mergedApproved.allowMutatingTools !== state.approvedGrants.allowMutatingTools ||
          mergedApproved.allowWorkspaceWrite !== state.approvedGrants.allowWorkspaceWrite ||
          mergedApproved.externalPathPrefixes.length !== (state.approvedGrants.externalPathPrefixes || []).length
        ) {
          state.approvedGrants = mergedApproved;
          changed = true;
        }
        if (changed && statePath) saveState(statePath, state);
      }
    } catch (_) {}
  }

  // 2. 若当前会话已固化 lockedWorkspaceRoots，直接返回（100% 免疫前台窗口切换）
  if (Array.isArray(state.lockedWorkspaceRoots) && state.lockedWorkspaceRoots.length > 0) {
    return state.lockedWorkspaceRoots;
  }

  const catalog = loadKnownProjectCatalog(homeDir);
  const profilesPath = path.join(homeDir, ".gemini", "config", "project-plugin-profiles.json");
  const convDbPath = path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db");

  let projectId = String(state.lockedProjectId || (payload && (payload.projectId || payload.project_id)) || "").trim();

  // 3. 严格通过 convId 从 conversation_summaries.db 查询本会话归属的 projectId（绝不读取前台焦点状态）
  if (!projectId && convId && fs.existsSync(convDbPath)) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(convDbPath, { readOnly: true, open: true });
      const row = db.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?").get(convId);
      db.close();
      if (row && row.project_id) projectId = String(row.project_id).trim();
    } catch (_) {}
  }

  // 4. 次选从 profiles.__meta__.convProjectMap[convId] 精确查表（禁止读取 lastActiveProjectId / lastSidecarProjectId）
  if (!projectId && convId && fs.existsSync(profilesPath)) {
    try {
      const profiles = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
      if (profiles && profiles.__meta__ && profiles.__meta__.convProjectMap && profiles.__meta__.convProjectMap[convId]) {
        projectId = String(profiles.__meta__.convProjectMap[convId]).trim();
      }
    } catch (_) {}
  }

  const collectedRoots = [];
  if (projectId && catalog.projectMap[projectId] && Array.isArray(catalog.projectMap[projectId].paths)) {
    collectedRoots.push(...catalog.projectMap[projectId].paths);
  }

  // 5. 收集当前会话载荷自身携带的 workspacePaths / workspaceUris（兜底支持尚未入库的新建会话）
  if (payload) {
    const rawUris = [];
    if (Array.isArray(payload.workspacePaths)) rawUris.push(...payload.workspacePaths);
    if (Array.isArray(payload.workspace_paths)) rawUris.push(...payload.workspace_paths);
    if (Array.isArray(payload.workspaceUris)) rawUris.push(...payload.workspaceUris);
    if (Array.isArray(payload.workspace_uris)) rawUris.push(...payload.workspace_uris);
    if (typeof payload.workspaceUri === "string") rawUris.push(payload.workspaceUri);
    if (typeof payload.cwd === "string" && collectedRoots.length === 0) rawUris.push(payload.cwd);

    for (const u of rawUris) {
      const nu = normalizePathForMatch(u);
      if (!nu) continue;
      if (!projectId) {
        let bestId = "";
        let bestScore = -1;
        for (const item of catalog.allKnownProjectRoots) {
          const score = nu === item.root ? 10000 + item.root.length : (nu.startsWith(item.root + "/") ? item.root.length : -1);
          if (score > bestScore) {
            bestScore = score;
            bestId = item.id;
          }
        }
        if (bestId) {
          projectId = bestId;
          if (catalog.projectMap[bestId]) {
            collectedRoots.push(...catalog.projectMap[bestId].paths);
          }
        }
      }
      if (collectedRoots.length === 0 || !projectId) {
        collectedRoots.push(nu);
      }
    }
  }

  const finalRoots = compactPathPrefixes(collectedRoots);
  let dirty = false;
  if (projectId && state.lockedProjectId !== projectId) {
    state.lockedProjectId = projectId;
    dirty = true;
  }
  if (finalRoots.length > 0) {
    state.lockedWorkspaceRoots = finalRoots;
    dirty = true;
  }
  if (dirty && statePath) {
    saveState(statePath, state);
  }
  return state.lockedWorkspaceRoots || [];
}

function promoteToCoarseExternalPrefix(normTarget, workspaceRoots, catalog, homeDir) {
  if (!normTarget) return "";
  if (isWhitelistedTarget(normTarget)) return "";
  if (isPathInsidePrefixes(normTarget, workspaceRoots)) return "";

  const normHome = normalizePathForMatch(homeDir || resolveHostHomeDir());

  // 1. 若命中已知外部项目根目录（或其子路径），自动提升为该外部项目根目录（除非该外部项目根目录反过来包含了当前工作区）
  let bestKnownRoot = "";
  for (const item of (catalog && catalog.allKnownProjectRoots) || []) {
    if (!item || !item.root) continue;
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

  // 2. 若命中 ~/.gemini/config/plugins/<pluginName>，且当前工作区不是 plugins 根目录，提升到插件目录级
  const pluginsRoot = normHome ? normHome + "/.gemini/config/plugins" : "";
  if (pluginsRoot && normTarget.startsWith(pluginsRoot + "/") && !isPathInsidePrefixes(pluginsRoot, workspaceRoots)) {
    const rest = normTarget.slice(pluginsRoot.length + 1);
    const seg = rest.split("/")[0];
    if (seg) return pluginsRoot + "/" + seg;
  }

  // 3. 若本身是目录或无扩展名路径，直接以该目录作为前缀；若是具体文件路径，提升到其父目录（严禁提升到盘符根或用户主目录根）
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

  // 1. 提取 file:/// URI
  const fileUriRegex = /file:\/\/\/[^\s"'`<>|)\]]+/gi;
  let m;
  while ((m = fileUriRegex.exec(combinedText)) !== null) {
    rawCandidates.push(cleanCandidatePathToken(m[0]));
  }

  // 2. 提取带引号与不带引号的 Windows 盘符路径（支持 D:\Visual Studio\private-projects 等含空格目录）
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

  // 4. 识别方案中直接提及的已知外部项目名或目录名（用户/AI 无需写详细完整路径即可申请对应外部项目权限）
  const lowerText = combinedText.toLowerCase();
  for (const item of catalog.allKnownProjectRoots) {
    if (!item || !item.root) continue;
    if (isPathInsidePrefixes(item.root, workspaceRoots)) continue;
    const baseName = path.posix.basename(item.root);
    const idToken = String(item.id || "").toLowerCase();
    const nameToken = String(item.name || "").toLowerCase();
    if (
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
  const os = require("os");
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
            ? "【方案门禁拦截 · 工作区外未申报路径修改】目标文件 \"" + rawTarget + "\" 位于当前会话固化的工作区（" + wsLabel + "）之外，且不在本轮方案已申请获批的工作区外路径范围（" + extLabel + "）内！若需修改工作区外的内容，请先在同一回合输出聊天正文解释（content），并调用 ask_question 在方案中向用户说明要修改哪些工作区外的项目或目录（无需写详细具体子文件路径，后台会自动申请该目录权限），待用户确认后再执行修改。"
            : "[Plan Guard Intercept | Undeclared Out-of-Workspace Modification] Target file \"" + rawTarget + "\" is outside the conversation's locked workspace (" + wsLabel + ") and is not covered by the approved out-of-workspace path prefixes (" + extLabel + ")! To modify out-of-workspace files, first output chat explanation (content) and call ask_question to declare which external project/directory will be modified (coarse directory path is sufficient; detailed leaf paths are not required), and wait for user approval."
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
              ? "【方案门禁拦截 · 终端命令涉及未申报的工作区外路径】检测到非只读终端命令操作了工作区（" + wsLabel + "）之外且未在本轮方案中申请获批的路径 \"" + tp + "\"（已批准外部范围：" + extLabel + "）！若需跨工作区执行同步、写入或提交，请先在聊天正文说明并通过 ask_question 申请该工作区外目录权限后再执行。"
              : "[Plan Guard Intercept | Terminal Command Targets Undeclared External Path] Mutating command references path \"" + tp + "\" outside the locked workspace (" + wsLabel + ") and outside approved external prefixes (" + extLabel + ")! Please declare the external directory in ask_question and obtain user approval before executing."
          };
        }
      }
    }
    return { allowed: true };
  }

  return { allowed: true };
}

function backfillLegacyApprovedGrantsIfNeeded(state, statePath, rawTranscriptPath, workspaceRoots, homeDir) {
  if (!state || !state.approved) return;
  if (state.approvedGrants && state.approvedGrants.allowMutatingTools) return;
  const planText = readCurrentConversationPlanArtifact(rawTranscriptPath, true);
  const extracted = extractScopeGrantsFromPlan([planText], workspaceRoots, homeDir);
  state.approvedGrants = mergeGrants(state.approvedGrants, mergeGrants(state.pendingGrants, extracted));
  if (statePath) saveState(statePath, state);
}

function syncTranscriptState(rawTranscriptPath, payload) {
  const statePath = getStatePath(rawTranscriptPath);
  const homeDir = resolveHostHomeDir();
  let tPath = rawTranscriptPath || "";
  const fullPath = tPath.endsWith("transcript.jsonl")
    ? tPath.replace(/transcript\.jsonl$/, "transcript_full.jsonl")
    : tPath;
  if (tPath.endsWith("transcript_full.jsonl")) {
    const compact = tPath.replace("transcript_full.jsonl", "transcript.jsonl");
    if (fs.existsSync(compact)) tPath = compact;
  }
  if (!tPath || !fs.existsSync(tPath)) {
    const initState = createInitialState();
    resolveAndLockWorkspaceRoots(payload, initState, null, rawTranscriptPath);
    return { exists: false, statePath, state: initState };
  }

  let state = loadState(statePath);
  const workspaceRoots = resolveAndLockWorkspaceRoots(payload, state, statePath, rawTranscriptPath);
  const fd = fs.openSync(tPath, "r");
  const stats = fs.fstatSync(fd);

  const canReadDelta = Boolean(
    state.stateVersion === 2 &&
    typeof state.lastScannedOffset === "number" &&
    state.lastScannedOffset > 0 &&
    state.lastScannedOffset <= stats.size
  );

  if (canReadDelta && state.lastScannedOffset === stats.size) {
    fs.closeSync(fd);
    backfillLegacyApprovedGrantsIfNeeded(state, statePath, rawTranscriptPath, workspaceRoots, homeDir);
    return { exists: true, statePath, state };
  }

  let readStart = 0;
  if (canReadDelta) {
    readStart = state.lastScannedOffset;
  } else {
    const preservedProjectId = state.lockedProjectId || "";
    const preservedRoots = Array.isArray(state.lockedWorkspaceRoots) ? state.lockedWorkspaceRoots : [];
    state = createInitialState();
    state.lockedProjectId = preservedProjectId;
    state.lockedWorkspaceRoots = preservedRoots;
    if (stats.size > 1048576) {
      const headSize = Math.min(stats.size, 65536);
      const headBuf = Buffer.alloc(headSize);
      fs.readSync(fd, headBuf, 0, headSize, 0);
      const headStr = headBuf.toString("utf-8");
      if (/"source"\s*:\s*"USER_EXPLICIT"|"type"\s*:\s*"USER_INPUT"/.test(headStr)) {
        state.hasUserInput = true;
      }
      const parentMatch = headStr.match(/\[Message\]\s+timestamp=[^\r\n]+?\s+sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (parentMatch && parentMatch[1]) {
        state.hasParentSenderMessage = true;
        state.parentConvId = parentMatch[1];
      }
      readStart = stats.size - 1048576;
    }
  }

  const readSize = stats.size - readStart;
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, readStart);
  fs.closeSync(fd);

  let offsetInBuf = 0;
  if (readStart > 0 && !canReadDelta) {
    const firstNl = buffer.indexOf(0x0a, 0);
    if (firstNl !== -1) {
      offsetInBuf = firstNl + 1;
    }
  }

  let lastValidOffset = readStart + offsetInBuf;

  while (offsetInBuf < buffer.length) {
    const nlIdx = buffer.indexOf(0x0a, offsetInBuf);
    const lineEnd = nlIdx !== -1 ? nlIdx : buffer.length;
    const nextOffsetInBuf = nlIdx !== -1 ? nlIdx + 1 : buffer.length;
    const rawLine = buffer.toString("utf-8", offsetInBuf, lineEnd).trim();

    if (!rawLine) {
      lastValidOffset = readStart + nextOffsetInBuf;
      offsetInBuf = nextOffsetInBuf;
      continue;
    }

    let e;
    try {
      e = JSON.parse(rawLine);
    } catch (err) {
      if (nlIdx === -1) break;
      lastValidOffset = readStart + nextOffsetInBuf;
      offsetInBuf = nextOffsetInBuf;
      continue;
    }

    const content = e.content || "";
    const stepIdx = typeof e.step_index === "number" ? e.step_index : -1;

    if (e.source === "USER_EXPLICIT" || e.type === "USER_INPUT") {
      state.hasUserInput = true;
    }
    if (e.type === "SYSTEM_MESSAGE" || e.source === "SYSTEM") {
      const senderMatch = content.match(/\[Message\]\s+timestamp=[^\r\n]+?\s+sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (senderMatch && senderMatch[1]) {
        state.hasParentSenderMessage = true;
        if (!state.parentConvId) state.parentConvId = senderMatch[1];
      }
    }

    if (state.approved && state.approvedStepIndex >= 0 && stepIdx >= 0 && stepIdx <= state.approvedStepIndex) {
      lastValidOffset = readStart + nextOffsetInBuf;
      offsetInBuf = nextOffsetInBuf;
      continue;
    }

    // 熔断线 3：用户在界面手动点击 Stop / Cancel 中断执行 -> 立即撤权并清空已批准权限
    if (e.status === "CANCELED" || e.status === "CANCELLED") {
      state.approved = false;
      state.approvedStepIndex = -1;
      state.lastResetReason = "canceled";
      state.pendingGrants = createEmptyGrants();
      state.approvedGrants = createEmptyGrants();
    }

    // 熔断线 1：新用户消息输入 -> 除非明确包含直接授权词，否则立即撤权并清空权限范围
    if (e.source === "USER_EXPLICIT" || e.type === "USER_INPUT") {
      const hadPlan = state.hasPlanSinceLastReset;
      state.pendingToolCalls = [];
      state.pendingStepIndex = -1;
      state.hasPlanSinceLastReset = false;
      state.hasAssistantContentSinceLastReset = false;
      state.currentAskStepFound = false;
      state.currentAskStepHasContent = false;
      if (isUserAuthorized(content)) {
        state.approved = true;
        state.approvedStepIndex = stepIdx;
        state.lastResetReason = "";
        const planArtifactText = readCurrentConversationPlanArtifact(rawTranscriptPath, hadPlan);
        const autoGrants = extractScopeGrantsFromPlan([planArtifactText], workspaceRoots, homeDir);
        state.approvedGrants = mergeGrants(state.approvedGrants, mergeGrants(state.pendingGrants, autoGrants));
        state.pendingGrants = createEmptyGrants();
      } else {
        state.approved = false;
        state.approvedStepIndex = -1;
        state.lastResetReason = "user_input";
        state.pendingGrants = createEmptyGrants();
        state.approvedGrants = createEmptyGrants();
      }
      lastValidOffset = readStart + nextOffsetInBuf;
      offsetInBuf = nextOffsetInBuf;
      continue;
    }

    if (e.type === "SYSTEM_MESSAGE" || e.source === "SYSTEM") {
      state.currentAskStepFound = false;
      state.currentAskStepHasContent = false;
      if (isUserAuthorized(content)) {
        state.approved = true;
        if (stepIdx >= 0) state.approvedStepIndex = stepIdx;
        const planArtifactText = readCurrentConversationPlanArtifact(rawTranscriptPath, true);
        const autoGrants = extractScopeGrantsFromPlan([planArtifactText], workspaceRoots, homeDir);
        state.approvedGrants = mergeGrants(state.approvedGrants, mergeGrants(state.pendingGrants, autoGrants));
      }
      lastValidOffset = readStart + nextOffsetInBuf;
      offsetInBuf = nextOffsetInBuf;
      continue;
    }

    if (e.type === "PLANNER_RESPONSE") {
      const visibleText = typeof e.content === "string" ? e.content.trim() : "";
      if (visibleText.length > 0) {
        state.hasAssistantContentSinceLastReset = true;
      }
      if (Array.isArray(e.tool_calls)) {
        state.pendingToolCalls = e.tool_calls;
        state.pendingStepIndex = stepIdx;
        for (const tc of e.tool_calls) {
          if (tc && WRITE_FILE_TOOLS.has(tc.name) && tc.args) {
            const tf = extractTargetFileFromArgs(tc.args).replace(/\\/g, "/").toLowerCase();
            if (tf.endsWith("implementation_plan.md")) {
              state.hasPlanSinceLastReset = true;
            }
          }
        }
        const callsAsk = e.tool_calls.some((tc) => tc && tc.name === "ask_question");
        if (callsAsk) {
          state.currentAskStepFound = true;
          state.currentAskStepHasContent = visibleText.length > 0;
          // 熔断线 2a：发起新的 ask_question 弹窗时，旧授权挂起等待新弹窗响应，并在后台提取本方案申请的权限范围
          state.approved = false;
          state.approvedStepIndex = -1;
          const askTexts = collectAskQuestionTexts(e.tool_calls, visibleText);
          const refsPlan = askTexts.some((t) => /implementation_plan\.md/i.test(t));
          const planArtifactText = readCurrentConversationPlanArtifact(rawTranscriptPath, state.hasPlanSinceLastReset || refsPlan);
          if (planArtifactText) askTexts.push(planArtifactText);
          state.pendingGrants = mergeGrants(state.pendingGrants, extractScopeGrantsFromPlan(askTexts, workspaceRoots, homeDir));
        }
      }
      lastValidOffset = readStart + nextOffsetInBuf;
      offsetInBuf = nextOffsetInBuf;
      continue;
    }

    if (e.type === "GENERIC") {
      const hadPlan = state.hasPlanSinceLastReset;
      state.currentAskStepFound = false;
      state.currentAskStepHasContent = false;
      if (
        e.status === "DONE" &&
        content.indexOf("Encountered error") === -1 &&
        /(Created file|replace_file_content tool to:|Wrote to|Edited file|Made \d+ replacement)[^\r\n]*implementation_plan\.md/i.test(content)
      ) {
        state.hasPlanSinceLastReset = true;
      }

      let presetOpts = extractAskQuestionPresetOptions(state.pendingToolCalls);
      if (presetOpts.size === 0 && state.pendingStepIndex >= 0 && fullPath && fs.existsSync(fullPath)) {
        try {
          const ffd = fs.openSync(fullPath, "r");
          const fstats = fs.fstatSync(ffd);
          const freadSize = Math.min(fstats.size, 2097152);
          const fbuf = Buffer.alloc(freadSize);
          fs.readSync(ffd, fbuf, 0, freadSize, Math.max(0, fstats.size - freadSize));
          fs.closeSync(ffd);
          const flines = fbuf.toString("utf-8").trim().split("\n");
          for (let j = flines.length - 1; j >= 0; j--) {
            try {
              const fe = JSON.parse(flines[j]);
              if (fe.step_index === state.pendingStepIndex && Array.isArray(fe.tool_calls)) {
                presetOpts = extractAskQuestionPresetOptions(fe.tool_calls);
                const fullAskTexts = collectAskQuestionTexts(fe.tool_calls, fe.content || "");
                state.pendingGrants = mergeGrants(state.pendingGrants, extractScopeGrantsFromPlan(fullAskTexts, workspaceRoots, homeDir));
                break;
              }
            } catch (e2) {}
          }
        } catch (e3) {}
      }

      const askEval = evaluateAskQuestionResponse(content, presetOpts);
      if (askEval.isAskResponse) {
        state.hasPlanSinceLastReset = false;
        state.hasAssistantContentSinceLastReset = false;
        if (askEval.approved) {
          state.approved = true;
          state.approvedStepIndex = stepIdx;
          state.lastResetReason = "";
          const planArtifactText = readCurrentConversationPlanArtifact(rawTranscriptPath, hadPlan);
          const fallbackGrants = extractScopeGrantsFromPlan([planArtifactText], workspaceRoots, homeDir);
          state.approvedGrants = mergeGrants(state.approvedGrants, mergeGrants(state.pendingGrants, fallbackGrants));
          state.pendingGrants = createEmptyGrants();
        } else {
          // 熔断线 2b：Write-In 提示词补充、点击暂不修改或跳过 -> 立即撤权归零并清空待生效申请
          state.approved = false;
          state.approvedStepIndex = -1;
          state.lastResetReason = askEval.isWriteIn ? "write_in" : "ask_rejected";
          state.pendingGrants = createEmptyGrants();
          state.approvedGrants = createEmptyGrants();
        }
        state.pendingToolCalls = [];
        state.pendingStepIndex = -1;
      }
    }

    lastValidOffset = readStart + nextOffsetInBuf;
    offsetInBuf = nextOffsetInBuf;
  }

  state.lastScannedOffset = lastValidOffset;
  resolveAndLockWorkspaceRoots(payload, state, null, rawTranscriptPath);
  backfillLegacyApprovedGrantsIfNeeded(state, null, rawTranscriptPath, state.lockedWorkspaceRoots, homeDir);
  saveState(statePath, state);
  return { exists: true, statePath, state };
}

function handlePreToolUse(payload) {
  try {
    const homeDir = resolveHostHomeDir();
    const userLang = detectUserLang(payload.transcriptPath);
    const toolCall = payload.toolCall || {};
    const toolName = toolCall.name || "";
    const args = toolCall.args || {};

    // 每次 PreToolUse 先执行增量字节同步与会话级工作区固化（0 新增字节时 O(1) 瞬时返回）
    const synced = syncTranscriptState(payload.transcriptPath, payload);
    const state = synced.state;
    const workspaceRoots = resolveAndLockWorkspaceRoots(payload, state, synced.statePath, payload.transcriptPath);

    // 阶段 1 & 2：全盘只读放行（模型无关纯只读工具、后台状态查询与只读子智能体不限工作区内外直接放行；ask_question 需通过阶段 5 审计后再放行）
    if (toolName !== "ask_question" && isModelAgnosticReadOnlyTool(toolName, args)) {
      return reply({ decision: "allow" });
    }
    if ((toolName === "invoke_subagent" || toolName === "Task") && isReadOnlySubagentCall(args)) {
      return reply({ decision: "allow" });
    }

    // 阶段 3：方案工件与调试目录放行（兼容全模型写盘工具名与参数名）
    if (WRITE_FILE_TOOLS.has(toolName)) {
      const rawTarget = extractTargetFileFromArgs(args);
      const targetFile = rawTarget.replace(/\\/g, "/");
      if (isWhitelistedTarget(targetFile)) {
        stripArtifactFeedbackButton(rawTarget, true);
        return reply({ decision: "allow" });
      }
    }

    // 阶段 4：终端命令只读审计（兼容 run_command 与 Bash，全盘只读命令免弹窗放行）
    if (EXEC_CMD_TOOLS.has(toolName)) {
      const cmd = String(args.CommandLine || args.command || "").trim();
      if (isPureReadOnlyCommand(cmd)) {
        return reply({ decision: "allow" });
      }
    }

    if (!synced.exists) {
      if (toolName === "ask_question") {
        return reply({ decision: "allow" });
      }
      return reply({
        decision: "deny",
        reason: userLang === "zh"
          ? "【方案门禁拦截】未检测到会话授权记录。请在同一回合先输出聊天正文解释（content），再调用 ask_question 在提问窗口中列出纯修改方案征得用户按钮确认后再执行修改。"
          : "[Plan Guard Intercept] No session approval record detected. Please first output chat explanation (content) in the same turn, then call ask_question to list the pure modification plan in the question modal for user button confirmation before making changes."
      });
    }

    // 子智能体会话识别：无人类直接输入（USER_EXPLICIT）且由父智能体 SYSTEM_MESSAGE (sender=<UUID>) 唤醒
    const isSubagent = !state.hasUserInput && state.hasParentSenderMessage;
    if (isSubagent) {
      if (toolName === "ask_question") {
        return reply({
          decision: "deny",
          reason: userLang === "zh"
            ? "【子智能体免弹窗直通】当前会话是由主智能体（Parent Agent）委派的子智能体，主智能体在派单前已取得用户按钮确认！子智能体严禁调用 ask_question 阻塞等待用户输入，请直接按主智能体下发的施工图并发执行文件读写与终端命令。"
            : "[Subagent Direct Execution] This conversation is a subagent delegated by the Parent Agent, which has already obtained user button confirmation! Subagents are STRICTLY FORBIDDEN from calling ask_question to block execution. Directly execute file operations and terminal commands concurrently per the plan."
        });
      }
      // 子智能体同样受父会话已获批的工作区与外部路径边界约束
      const subScopeCheck = verifyToolCallAgainstApprovedGrants(
        toolName,
        args,
        workspaceRoots,
        state.approvedGrants,
        homeDir,
        userLang
      );
      if (!subScopeCheck.allowed) {
        return reply({ decision: "deny", reason: subScopeCheck.reason });
      }
      return reply({ decision: "allow" });
    }

    // 针对主智能体 ask_question 本身的「必先输出聊天正文解释」「防折叠藏匿」「分级展示」与「后台自动提取申请权限」
    if (toolName === "ask_question") {
      if ((state.currentAskStepFound && !state.currentAskStepHasContent) || (!state.currentAskStepFound && !state.hasAssistantContentSinceLastReset)) {
        return reply({
          decision: "deny",
          reason: userLang === "zh"
            ? "【方案门禁拦截 · 严禁无正文裸调弹窗】检测到你在调用 ask_question 的当前回合未输出任何聊天正文解释（content 字段为空），导致用户只能看到干巴巴的修改弹窗而看不到原因分析与解释！请在同一回合中先在聊天正文（content）输出完整的分析与解释说明，再同时调用 ask_question（question 窗口仅列纯修改方案与文件芯片）。"
            : "[Plan Guard Intercept | Empty Content Forbidden] Calling ask_question with empty chat content is blocked! The user must see the rationale and analysis in chat before the popup. Please output full explanations in chat body (content) first in the same turn, and simultaneously call ask_question (keep question window focused on modification plan and file chips)."
        });
      }
      const qs = parseToolArg(args.questions);
      const askPlanTexts = [];
      if (Array.isArray(qs)) {
        const lazyRefRegex = /(详见正文|见正文|如上所述|见上方|详见上方|同正文|方案见正文|详见方案|见方案|见上文|参考正文|参考上文|详见\s*implementation_plan|see above|see chat|as described above|refer to above|see details above|same as above)/i;
        for (const q of qs) {
          const qText = String((q && q.question) || "");
          if (qText) askPlanTexts.push(qText);
          if (lazyRefRegex.test(qText)) {
            return reply({
              decision: "deny",
              reason: userLang === "zh"
                ? "【方案门禁拦截 · 严禁折叠藏匿与冗余指代】严禁在 question 中写「详见正文/详见方案/详见 implementation_plan.md」等占位词！请在同一回合先输出聊天正文（content）解释，并将【纯修改方案（说明改哪些内容，以及改哪些工作区外的项目/目录）】直接写在 ask_question 的 question 窗口中，options 选项只放极简动作按钮（如「(Recommended) 确认执行」「采用方案 A」「暂不修改」，严禁在 options 中重复抄写方案），然后重新调用 ask_question。"
                : "[Plan Guard Intercept | Lazy References Forbidden] Using placeholders like 'see above / refer to plan / see implementation_plan.md' in question is forbidden! Output analysis in chat body (content) first, and put the pure modification plan (what will be modified and which out-of-workspace directories/projects are involved) directly in the ask_question modal. Keep options strictly to concise action buttons (e.g., '(Recommended) Confirm & Execute', 'Cancel'; never duplicate plan text in options), then call ask_question again."
            });
          }
          if (Array.isArray(q && q.options)) {
            if (q.options.length < 2) {
              return reply({
                decision: "deny",
                reason: userLang === "zh"
                  ? "【方案门禁拦截 · 选项数量不足】ask_question 的 options 必须至少提供 2 个可选项（例如单方案：[\"(Recommended) 确认执行\", \"暂不修改\"]；多方案：[\"(Recommended) 采用方案 A\", \"采用方案 B\", \"暂不修改\"]）。"
                  : "[Plan Guard Intercept | Insufficient Options] The options in ask_question must provide at least 2 selectable choices (e.g., single option: [\"(Recommended) Confirm & Execute\", \"Cancel\"]; multiple options: [\"(Recommended) Option A\", \"Option B\", \"Cancel\"])."
              });
            }
            for (const opt of q.options) {
              const optText = String(opt || "").trim();
              if (optText.length > 40) {
                return reply({
                  decision: "deny",
                  reason: userLang === "zh"
                    ? "【方案门禁拦截 · 选项过长】检测到 options 文本长度超过 40 字符（\"" + optText.slice(0, 30) + "...\"）。options 仅作为极简确认按钮（如「(Recommended) 确认执行」「暂不修改」），严禁在 options 中重复抄写方案或长句解释！"
                    : "[Plan Guard Intercept | Option Too Long] Detected option text exceeding 40 characters (\"" + optText.slice(0, 30) + "...\"). Keep options strictly as concise action buttons (e.g., '(Recommended) Confirm & Execute', 'Cancel'); do NOT duplicate plan text or long explanations in options!"
                });
              }
            }
          }
        }
      }
      // 审计通过：后台隐式申请修改工具权限 + 提取方案中声明的工作区外粗粒度路径权限并持久化到 pendingGrants
      const refsPlan = askPlanTexts.some((t) => /implementation_plan\.md/i.test(t));
      const planArtifactText = readCurrentConversationPlanArtifact(payload.transcriptPath, state.hasPlanSinceLastReset || refsPlan);
      if (planArtifactText) askPlanTexts.push(planArtifactText);
      state.pendingGrants = mergeGrants(state.pendingGrants, extractScopeGrantsFromPlan(askPlanTexts, workspaceRoots, homeDir));
      saveState(synced.statePath, state);
      return reply({ decision: "allow" });
    }

    // 分支 1：已通过 ask_question 预设选项点击或明确授权 -> 按本轮获批的权限范围（工作区内 + 已申请工作区外目录前缀）精准放行，严控未申请的工作区外修改
    if (state.approved) {
      const scopeCheck = verifyToolCallAgainstApprovedGrants(
        toolName,
        args,
        workspaceRoots,
        state.approvedGrants,
        homeDir,
        userLang
      );
      if (!scopeCheck.allowed) {
        return reply({
          decision: "deny",
          reason: scopeCheck.reason
        });
      }
      return reply({ decision: "allow" });
    }

    // 分支 2：用户在 ask_question 中使用了自定义输入（Write-In 提示词补充），模型尚未重新调用 ask_question 获得确认
    if (state.lastResetReason === "write_in") {
      return reply({
        decision: "deny",
        reason: userLang === "zh"
          ? "【方案门禁拦截 · Write-In 提示词补充】检测到用户在 ask_question 中自行输入了文字（Write-In），这属于提示词补充而非确认！请先在同一回合的聊天正文（content）中回应用户的补充要求并说明调整原因，同时再次调用 ask_question（在 question 窗口中直接列出更新后的纯修改方案，options 只放极简确认按钮）供用户确认。"
          : "[Plan Guard Intercept | Write-In Prompt Refinement] User input custom text (Write-In) in ask_question, which represents prompt refinement rather than confirmation! Please address the user feedback and rationale in chat content first, and call ask_question again (list updated pure modification plan in question, concise buttons in options) for user confirmation."
      });
    }

    // 分支 3：已生成 implementation_plan.md 但尚未调用 ask_question 取得用户按钮确认 -> 拦截同回合抢跑
    if (state.hasPlanSinceLastReset) {
      return reply({
        decision: "deny",
        reason: userLang === "zh"
          ? "【方案门禁拦截 · 等待按钮确认】已生成 implementation_plan.md 大卡片，但尚未通过 ask_question 征得用户按钮确认！请在同一回合先输出聊天正文解释（content），并同时调用 ask_question 弹出确认面板：在 question 窗口中直接列出核心修改方案（说明改哪些东西、若涉及工作区外需说明改哪些工作区外目录/模块，后台会自动申请对应修改工具与路径权限），options 仅放极简动作按钮（如「(Recommended) 确认执行」「暂不修改」），等待用户勾选提交后再执行修改。"
          : "[Plan Guard Intercept | Awaiting Button Confirmation] implementation_plan.md artifact generated, but user button confirmation via ask_question has not been obtained! In the same turn, output explanations in chat content first, and call ask_question to present the confirmation modal: list core modification plan and any out-of-workspace directories/modules in question directly (background will automatically request tool and path permissions), keep options as concise action buttons (e.g., '(Recommended) Confirm & Execute', 'Cancel'), and wait for user submission before modifying."
      });
    }

    // 分支 4：尚未调用 ask_question 确认 -> 阻断并引导模型按分级策略调用 ask_question 申请权限
    let actionDesc = "状态修改或代码写盘操作";
    let actionDescEn = "state mutation or file writing";
    if (toolName === "run_command" || toolName === "Bash") {
      actionDesc = "具有环境或服务修改副作用的终端命令";
      actionDescEn = "terminal commands with environmental/service side effects";
    } else if (toolName === "invoke_subagent" || toolName === "Task") {
      actionDesc = "派发写盘/执行类子智能体";
      actionDescEn = "dispatching mutating subagents";
    } else if (toolName.indexOf("mcp") !== -1) {
      actionDesc = "具有外部写入或修改副作用的 MCP 工具";
      actionDescEn = "MCP tools with external modification side effects";
    } else if (toolName === "manage_task") {
      actionDesc = "具有控制副作用的后台进程操作";
      actionDescEn = "background task management with control side effects";
    }

    const zhReason = "【方案门禁拦截 · 按单申请与工作区内外把控】检测到尚未通过按钮确认即尝试执行" + actionDesc + "（工具：" + toolName + "）。当前门禁允许你在出方案前全盘调用任意只读工具免弹窗调研；在执行任何修改前，请按分级策略触发 ask_question 按钮确认：1) 同回合先正文解释再弹窗：调用 ask_question 的同一回合必须先在聊天正文（content）输出完整的原因分析与原理解释，ask_question 的 question 窗口直接列出【纯修改方案】（说明改哪些东西，无需写明具体修改工具名；若需修改当前工作区外的内容，请在方案中说明改哪些工作区外的项目或目录，无需写详细具体子文件路径，后台会自动提取并申请修改工具与外部路径权限）；2) 简单任务（≤3文件）免写 implementation_plan.md，复杂任务（>3文件或多方案架构）先写 implementation_plan.md 并在 question 标题旁附带 [implementation_plan.md](file:///...) 芯片；3) 选项零复读：options 仅放极简动作按钮（单方案用「(Recommended) 确认执行 / 暂不修改」，多方案用「(Recommended) 采用方案 A / 采用方案 B / 暂不修改」），用户确认后将自动放行已申请的工作区内及工作区外修改，未申请的工作区外路径仍将被严格拦截！";

    const enReason = "[Plan Guard Intercept | Scoped Permission Application] Attempted " + actionDescEn + " (tool: " + toolName + ") before user button confirmation! Full-disk read-only tools are allowed without popups during research; before making any changes, trigger ask_question button confirmation: 1) Chat explanation before popup in same turn: output full analysis and rationale in chat content first, list pure modification plan directly in ask_question modal (explain what will be modified without needing specific tool names; if modifying files outside the current workspace, state which external project/directory will be modified without needing detailed leaf file paths—background automatically requests tool and path permissions); 2) Skip implementation_plan.md for simple tasks (<=3 files); generate implementation_plan.md for complex tasks (>3 files); 3) Concise action buttons only in options ([\"(Recommended) Confirm & Execute\", \"Cancel\"]). Once approved, declared workspace and external path modifications will be allowed while undeclared external paths remain strictly blocked!";

    return reply({
      decision: "deny",
      reason: userLang === "zh" ? zhReason : enReason
    });
  } catch (e) {
    return reply({ decision: "allow" });
  }
}

function stripArtifactFeedbackFileSync(metaPath) {
  try {
    if (!metaPath || !fs.existsSync(metaPath)) return;
    const raw = fs.readFileSync(metaPath, "utf8");
    const data = JSON.parse(raw);
    if (data && data.requestFeedback !== false) {
      data.requestFeedback = false;
      fs.writeFileSync(metaPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    }
  } catch (e) {}
}

function stripArtifactFeedbackButton(targetFile, spawnFollowUp) {
  try {
    if (!targetFile) return;
    const norm = path.normalize(String(targetFile));
    const metaPath = norm.endsWith(".metadata.json") ? norm : norm + ".metadata.json";
    stripArtifactFeedbackFileSync(metaPath);
    if (spawnFollowUp) {
      const { spawn } = require("child_process");
      const child = spawn(
        process.execPath,
        [__filename, "strip-meta", metaPath],
        { detached: true, stdio: "ignore", windowsHide: true }
      );
      child.unref();
    }
  } catch (e) {}
}

function handlePostToolUse(payload) {
  try {
    const toolCall = payload.toolCall || {};
    const toolName = toolCall.name || "";
    const args = toolCall.args || {};
    if (WRITE_FILE_TOOLS.has(toolName)) {
      const rawTarget = extractTargetFileFromArgs(args);
      if (isWhitelistedTarget(rawTarget)) {
        stripArtifactFeedbackButton(rawTarget, false);
      }
    }
    // 执行增量同步（仅实际解析新增 JSONL 行，绝不盲目覆盖 lastScannedOffset）
    if (payload && payload.transcriptPath) {
      syncTranscriptState(payload.transcriptPath, payload);
    }
  } catch (e) {}
  return reply({});
}

function handlePreInvocation(payload) {
  let wsSummary = "";
  try {
    if (payload && payload.transcriptPath) {
      const synced = syncTranscriptState(payload.transcriptPath, payload);
      if (synced.exists && Array.isArray(synced.state.lockedWorkspaceRoots) && synced.state.lockedWorkspaceRoots.length > 0) {
        wsSummary = synced.state.lockedWorkspaceRoots.join(", ");
      }
      if (synced.exists && synced.state.approved) {
        return reply({});
      }
    }
  } catch (e) {}
  const userLang = detectUserLang(payload && payload.transcriptPath);
  const wsHintZh = wsSummary ? "（当前会话已独立固化工作区：" + wsSummary + "，前后台切换项目互不串扰）" : "";
  const wsHintEn = wsSummary ? " (Conversation-locked workspace: " + wsSummary + ", immune to foreground project switching)" : "";
  const zhMessage = "【方案门禁在线（全盘只读免弹窗 · 按单申请修改与跨区权限 · 子智能体免弹窗直通）】" + wsHintZh + " 1) 出方案前允许全盘调用任意只读工具（read_file/list_dir/grep_search/只读终端命令/research 子智能体）免弹窗勘测；2) 若当前会话是由主智能体委派的子智能体（Subagent，含 sender=<UUID>），严禁调用 ask_question 弹窗阻塞，直接在主智能体已获批的工作区与外部路径范围内并发执行！3) 若当前会话为主智能体（Main Agent），执行任何修改前必须同回合先输出聊天正文解释（content）再调用 ask_question 列出【纯修改方案】：方案中说明要改哪些内容（无需写明具体修改工具名，后台自动申请修改工具权限）；若涉及修改当前工作区外的内容，必须在方案中说明要改哪些工作区外的项目或目录（无需写详细具体子文件路径，后台自动提取并申请该外部目录权限）；options 仅放极简按钮（如 [\"(Recommended) 确认执行\", \"暂不修改\"]）。用户同意后自动放行已申请范围，未申请的工作区外修改将被严格拦截！";
  const enMessage = "[Plan Guard Online (Full-Disk Read Free | Scoped Mutation & External Path Grants | Subagents Bypass)]" + wsHintEn + " 1) Full-disk read-only tools (read_file/list_dir/grep_search/read-only commands/research subagent) are allowed without popups before proposing a plan; 2) If this conversation is a Subagent (woken by sender=<UUID>), NEVER call ask_question; execute directly within the parent's approved workspace and external path scope! 3) If this is the Main Agent, before any modification, output full explanation in chat content first and call ask_question in the same turn to list the pure modification plan: explain what will be modified (no need to list specific tool names; background automatically requests mutation tool permissions); if modifying anything outside the current workspace, state which external project/directory will be modified (coarse directory/project path is sufficient without detailed leaf paths; background automatically requests external path permissions); keep options to concise buttons ([\"(Recommended) Confirm & Execute\", \"Cancel\"]). Approved scopes are allowed while undeclared external paths remain strictly blocked!";
  return reply({
    injectSteps: [{
      ephemeralMessage: userLang === "zh" ? zhMessage : enMessage
    }]
  });
}

function handleStop(payload) {
  try {
    if (payload && payload.transcriptPath) {
      const synced = syncTranscriptState(payload.transcriptPath, payload);
      const reason = String(payload.terminationReason || "");
      // 官方 Stop 契约：当用户取消（USER_CANCELED）或当前回合完全结束且无后台任务（NO_TOOL_CALL && fullyIdle）时，自动归零本轮授权与已申请范围（保留会话固化的 lockedWorkspaceRoots）
      if (reason === "USER_CANCELED" || (reason === "NO_TOOL_CALL" && payload.fullyIdle === true)) {
        synced.state.approved = false;
        synced.state.approvedStepIndex = -1;
        synced.state.pendingGrants = createEmptyGrants();
        synced.state.approvedGrants = createEmptyGrants();
        saveState(synced.statePath, synced.state);
      }
    }
  } catch (e) {}
  return reply({ decision: "allow" });
}

function isPlanGuardEnabledForPayload(payload) {
  if (process.env.PLAN_GUARD_FORCE_ENABLED === "1") return true;
  try {
    const homeDir = resolveHostHomeDir();
    const profilesPath = path.join(homeDir, ".gemini", "config", "project-plugin-profiles.json");
    const configPath = path.join(homeDir, ".gemini", "config", "config.json");
    const convDbPath = path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db");

    let profiles = null;
    if (fs.existsSync(profilesPath)) {
      try { profiles = JSON.parse(fs.readFileSync(profilesPath, "utf8")); } catch (_) {}
    }
    if (!profiles && fs.existsSync(profilesPath + ".bak")) {
      try { profiles = JSON.parse(fs.readFileSync(profilesPath + ".bak", "utf8")); } catch (_) {}
    }

    let convId = String(
      (payload && (payload.conversationId || payload.conversation_id || payload.trajectoryId || payload.trajectory_id || payload.cascadeId)) || ""
    ).trim();
    if (!convId && payload && (payload.transcriptPath || payload.transcript_path)) {
      const m = String(payload.transcriptPath || payload.transcript_path).replace(/\\/g, "/").match(/\/brain\/([0-9a-f-]{36})\//i);
      if (m && m[1]) convId = m[1];
    }

    let projectId = String((payload && (payload.projectId || payload.project_id)) || "").trim();

    // 1. 优先从 SQLite 权威表查询会话所属的真实 project_id（含纯聊天项目）
    if (!projectId && convId && fs.existsSync(convDbPath)) {
      try {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(convDbPath, { readOnly: true, open: true });
        const row = db.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?").get(convId);
        db.close();
        if (row && row.project_id) projectId = String(row.project_id).trim();
      } catch (_) {}
    }

    // 2. 次选从 profiles.__meta__.convProjectMap 按 convId 精确查表（严禁读取前台焦点状态）
    if (!projectId && convId && profiles && profiles.__meta__) {
      const mapped = profiles.__meta__.convProjectMap && profiles.__meta__.convProjectMap[convId];
      if (mapped && profiles[mapped]) {
        projectId = mapped;
      }
    }

    // 3. 若仍未命中，根据会话显式挂载的 workspaceUris 匹配项目路径（不把读文件的工具参数当作会话所属项目）
    if (!projectId && profiles && payload) {
      const uris = [];
      if (Array.isArray(payload.workspaceUris)) uris.push(...payload.workspaceUris);
      else if (Array.isArray(payload.workspace_uris)) uris.push(...payload.workspace_uris);
      else if (typeof payload.workspaceUri === "string") uris.push(payload.workspaceUri);
      else if (typeof payload.cwd === "string") uris.push(payload.cwd);

      let bestId = "";
      let bestScore = -1;
      for (const u of uris) {
        const nu = normalizePathForMatch(u);
        if (!nu) continue;
        for (const [k, prof] of Object.entries(profiles)) {
          if (k === "__meta__" || k === "__default__" || !prof || !Array.isArray(prof.paths)) continue;
          for (const p of prof.paths) {
            const np = normalizePathForMatch(p);
            if (!np) continue;
            const score = nu === np ? 10000 + np.length : (nu.startsWith(np + "/") ? np.length : -1);
            if (score > bestScore) {
              bestScore = score;
              bestId = k;
            }
          }
        }
      }
      if (bestId) projectId = bestId;
    }

    // 4. 核对目标项目的 plan-guard 独立配置开关
    if (projectId && profiles && profiles[projectId] && profiles[projectId].plugins && profiles[projectId].plugins["plan-guard"] !== undefined) {
      return Boolean(profiles[projectId].plugins["plan-guard"]);
    }

    // 5. 若未命中已登记项目，优先回退到 profiles.__default__（默认配置），防止被其他关闭了 plan-guard 的项目动态刷写的 config.json 瞬态污染
    if (profiles && profiles.__default__ && profiles.__default__.plugins && profiles.__default__.plugins["plan-guard"] !== undefined) {
      return Boolean(profiles.__default__.plugins["plan-guard"]);
    }

    // 6. 最终兜底核对全局 config.json
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (cfg && cfg.plugins && cfg.plugins["plan-guard"] && cfg.plugins["plan-guard"].enabled !== undefined) {
        return cfg.plugins["plan-guard"].enabled !== false;
      }
    }
  } catch (_) {}
  return true;
}

async function main() {
  const mode = process.argv[2] || "pre-tool";
  if (mode === "strip-meta") {
    const metaPath = process.argv[3];
    stripArtifactFeedbackFileSync(metaPath);
    for (const delay of [80, 250, 600]) {
      await new Promise((r) => setTimeout(r, delay));
      stripArtifactFeedbackFileSync(metaPath);
    }
    process.exit(0);
  }
  const raw = await readStdin();
  let payload = {};
  try { if (raw.trim()) payload = JSON.parse(raw); } catch (e) {}
  if (!isPlanGuardEnabledForPayload(payload)) {
    if (mode === "pre-invocation" || mode === "post-tool") return reply({});
    return reply({ decision: "allow" });
  }
  if (mode === "pre-invocation") handlePreInvocation(payload);
  else if (mode === "post-tool") handlePostToolUse(payload);
  else if (mode === "stop") handleStop(payload);
  else handlePreToolUse(payload);
}

main();
