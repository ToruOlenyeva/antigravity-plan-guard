// Antigravity Plan Guard · 只读工具白名单、终端命令无副作用审计、弹窗响应解析与快照工具模块
const fs = require("fs");
const path = require("path");

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

function parseToolArg(val) {
  if (val === undefined || val === null) return val;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch (e) { return val; }
  }
  return val;
}

function isModelAgnosticReadOnlyTool(toolName, args = {}) {
  if (!toolName || typeof toolName !== "string") return false;
  if (SAFE_READ_TOOLS.has(toolName)) return true;

  if (toolName === "manage_task") {
    const act = String(parseToolArg(args.Action || args.action) || "").toLowerCase();
    if (act === "status" || act === "list" || act === "kill" || act === "send_input") return true;
    return false;
  }

  if (toolName === "manage_subagents") {
    const act = String(parseToolArg(args.Action || args.action) || "").toLowerCase();
    if (act === "list") return true;
    return false;
  }

  if (toolName === "call_mcp_tool") {
    const mcpTool = String(parseToolArg(args.ToolName) || "");
    if (
      (/^(get_|list_|search_|read_|view_|sequentialthinking$)/i.test(mcpTool) ||
        /(^|_)(read|view|get|list|search|find|grep|fetch|inspect|check)(_|$)/i.test(mcpTool)) &&
      !/(write|edit|replace|create|delete|remove|update|run|exec|kill|push|commit|send|merge|fork)/i.test(mcpTool)
    ) {
      return true;
    }
    return false;
  }

  if (
    WRITE_FILE_TOOLS.has(toolName) ||
    EXEC_CMD_TOOLS.has(toolName) ||
    toolName === "invoke_subagent" ||
    toolName === "define_subagent" ||
    toolName === "schedule"
  ) {
    return false;
  }

  if (
    /^(mcp_[\w-]+_)?(read|view|get|list|search|find|grep|fetch|inspect|check)(_|$)/i.test(toolName) &&
    !/(write|edit|replace|create|delete|remove|update|run|exec|kill|push|commit|send|patch|modify)/i.test(toolName)
  ) {
    return true;
  }

  return false;
}

function extractTargetFileFromArgs(args = {}) {
  return String(
    parseToolArg(args.TargetFile) ||
    parseToolArg(args.Path) ||
    parseToolArg(args.FilePath) ||
    parseToolArg(args.file_path) ||
    parseToolArg(args.path) ||
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

function isPureReadOnlyCommand(cmd) {
  if (!cmd) return false;
  const c = cmd.toLowerCase().replace(/[\r\n]/g, " ").trim();
  const cNoStdErr = c.replace(/\b2>\s*\/dev\/null\b/g, "").replace(/\b2>&1\b/g, "");

  if (
    cNoStdErr.indexOf(">") !== -1 ||
    cNoStdErr.indexOf("out-file") !== -1 ||
    cNoStdErr.indexOf("set-content") !== -1 ||
    cNoStdErr.indexOf("add-content") !== -1
  ) {
    return false;
  }

  if (/^ssh(\s|$)/.test(c)) {
    const remoteMutations = /\b(sed\s+-i|tee\b|rm\b|mv\b|cp\b|scp\b|rsync\b|systemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload|edit|set-property)|service\s+\S+\s+(start|stop|restart|reload)|docker\s+(run|rm|rmi|stop|start|restart|kill|pause|unpause|update|build|pull|push|commit|cp|create|network\s+create|network\s+rm|volume\s+create|volume\s+rm|compose\s+up|compose\s+down|compose\s+restart)|qm\s+(start|stop|reboot|reset|shutdown|suspend|resume|destroy|set|clone|migrate|rollback|snapshot|delonestop)|pct\s+(start|stop|reboot|shutdown|destroy|set)|apt\b|apt-get\b|dpkg\s+-(i|r|p|b)|opkg\s+(install|remove|upgrade)|yum\b|dnf\b|apk\s+(add|del)|curl\s+.*(-o|-O|-X\s*(POST|PUT|DELETE|PATCH)|--data|-d)|wget\b|reboot\b|shutdown\b|poweroff\b|init\b|chmod\b|chown\b|chgrp\b|kill\b|pkill\b|killall\b|mkdir\b|touch\b|ln\b|mount\b|umount\b|ufw\s+(enable|disable|allow|deny|delete|reset|reload)|firewall-cmd\s+.*(--add-|--remove-|--change-|--set-|--reload|--complete-reload|--runtime-to-permanent)|iptables\s+.*(-[AIiDRFPZNX]|--append|--insert|--delete|--replace|--flush|--zero|--new-chain|--delete-chain|--policy)|nft\s+(add|insert|replace|create|delete|destroy|flush|rename|reset|-f)|crontab\s+-[er]|useradd\b|userdel\b|usermod\b|passwd\b|visudo\b|dd\b|mkfs\b|fdisk\b|parted\b)/i;
    if (remoteMutations.test(cNoStdErr)) return false;

    const pureRemoteReads = /\b(cat|grep|egrep|fgrep|ls|ps|head|tail|find|which|whereis|type|echo|uptime|top|free|df|du|stat|uname|hostname|id|whoami|ip|ss|netstat|lsof|ping|curl|tcpdump|traceroute|tracepath|dig|nslookup|host|firewall-cmd\s+(--state|--get-|--list-|--query-|--info-|--version)|ufw\s+(status|version)|nft\s+list|iptables\s+(-[LSvnx]|--list|--list-rules)|dpkg\s+-l|opkg\s+list-installed|docker\s+(ps|top|inspect|logs|stats|images|version|info|exec)|qm\s+(status|list|config|guest\s+exec)|pct\s+(status|list|config)|systemctl\s+(status|is-active|is-enabled|list-units|list-unit-files|show)|journalctl)\b/i;
    if (pureRemoteReads.test(cNoStdErr)) return true;

    return false;
  }

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

function isReadOnlySubagentCall(args) {
  if (!args) return false;
  const isReadOnlyType = (t) => /^(research|explore)$|(-auditor|-reader|-explorer)$/i.test(t);
  const directType = String(parseToolArg(args.TypeName || args.typeName || args.subagent_type) || "").trim().toLowerCase();
  if (directType) return isReadOnlyType(directType);
  const subs = parseToolArg(args.Subagents);
  if (!Array.isArray(subs) || subs.length === 0) return false;
  return subs.every((s) => {
    const t = String((s && (s.TypeName || s.typeName)) || "").trim().toLowerCase();
    return isReadOnlyType(t);
  });
}

function findRawDetailedPathInAskQuestion(qText) {
  if (!qText || typeof qText !== "string") return "";
  const visibleOnly = qText.replace(/\[([^\]]+)\]\((?:file:\/\/\/|https?:\/\/)[^)]+\)/gi, "[$1]");

  const rawFileUri = visibleOnly.match(/file:\/\/\/[^\s"'`<>|)\]]+/i);
  if (rawFileUri && rawFileUri[0]) return rawFileUri[0];

  const rawDrivePath = visibleOnly.match(/\b[a-zA-Z]:[\\/][^\s"'`<>|)\]]+/i);
  if (rawDrivePath && rawDrivePath[0]) {
    return rawDrivePath[0].replace(/[),.;:!?'"`\]>]+$/g, "");
  }

  const rawDotGemini = visibleOnly.match(/(?:~[\\/]|%[A-Z_]+%[\\/]|\$env:[A-Za-z_]+[\\/])?\.gemini[\\/](?:config|antigravity)[\\/][^\s"'`<>|)\]]+/i);
  if (rawDotGemini && rawDotGemini[0]) {
    return rawDotGemini[0].replace(/[),.;:!?'"`\]>]+$/g, "");
  }

  return "";
}

function isUserAuthorized(text) {
  if (!text) return false;
  if (/approved this document|proceed with the implementation|user approved|accepted the plan/i.test(text)) return true;
  let clean = text.replace(/<USER_REQUEST>|<\/USER_REQUEST>|<ADDITIONAL_METADATA>[\s\S]+?<\/ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>[\s\S]+?<\/USER_SETTINGS_CHANGE>/g, "").trim();
  if (clean.startsWith("@[Quote]")) clean = clean.slice(8).trim();
  const pauseSignals = /(先等下|慢着|等等|暂停|别动|不要动|停下|先别|不要改|先不改|等一下|先停|仅讨论|只看方案|先不执行)/;
  if (pauseSignals.test(clean)) return false;
  if (/^(我想选|我选|选择|采用|就选|就用|选)\s*方案\s*[A-Za-z0-9一二三四]/i.test(clean)) return true;
  if (/[?？]/.test(clean) || /(为什么|怎么|能不能|你可以|难道|是否|有吗|好用吗|对吗|更好|是不是|忘了|没弄)/.test(clean)) return false;
  const standaloneAuth = /^(确认|确认执行|同意执行|按方案执行|开始执行|继续执行|立即执行|执行吧|修吧|改吧|动手吧|照此修改|同意|可以|好的|没问题|行|继续|好|ok|yes|proceed|approve)[!！。.\s]*$/i;
  if (standaloneAuth.test(clean)) return true;
  const explicitAction = /^(确认|同意|批准|准许|按方案|照方案)[\s\S]{0,20}(修改|修复|执行|改动|重构|落实|落地)[!！。.\s]*$/;
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
            if (typeof opt === "string" && opt.trim()) preset.add(opt.trim());
          }
        }
      }
    } else if (typeof rawQuestions === "string" && rawQuestions.indexOf('"options"') !== -1) {
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
    if (!ans || /^(skipped|canceled|cancelled)$/i.test(ans)) return { isAskResponse: true, approved: false, isWriteIn: false };
    if (rejectSignals.test(ans)) return { isAskResponse: true, approved: false, isWriteIn: false };
    if (standardApprovePreset.test(ans) || ans.startsWith("(Recommended)")) continue;
    if (!presetOptions || presetOptions.size === 0) return { isAskResponse: true, approved: false, isWriteIn: true };
    if (!presetOptions.has(ans)) {
      const parts = ans.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
      const allPartsInPreset = parts.length > 1 && parts.every((p) => presetOptions.has(p) || p.startsWith("(Recommended)"));
      if (!allPartsInPreset) return { isAskResponse: true, approved: false, isWriteIn: true };
    }
  }
  return { isAskResponse: true, approved: true, isWriteIn: false };
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

function stripArtifactFeedbackButton(targetFile, spawnFollowUp, entryScriptPath) {
  try {
    if (!targetFile) return;
    const norm = path.normalize(String(targetFile));
    const metaPath = norm.endsWith(".metadata.json") ? norm : norm + ".metadata.json";
    stripArtifactFeedbackFileSync(metaPath);
    if (spawnFollowUp && entryScriptPath) {
      const { spawn } = require("child_process");
      const child = spawn(process.execPath, [entryScriptPath, "strip-meta", metaPath], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    }
  } catch (e) {}
}

function readTaskLogSnapshot(logPath) {
  try {
    if (!logPath || !fs.existsSync(logPath)) return { exists: false, size: 0, tailText: "" };
    const stat = fs.statSync(logPath);
    const size = Number(stat.size) || 0;
    if (size <= 0) return { exists: true, size: 0, tailText: "" };
    const readLen = Math.min(size, 2048);
    const fd = fs.openSync(logPath, "r");
    const buf = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, size - readLen);
    fs.closeSync(fd);
    return { exists: true, size, tailText: buf.subarray(0, bytesRead).toString("utf8") };
  } catch (_) {
    return { exists: false, size: 0, tailText: "" };
  }
}

function isFastCompletionOrPromptTail(tailText) {
  const s = String(tailText || "").slice(-600).trim();
  if (!s) return false;
  if (/(?:\([yY]\/[nN]\)|\[[yY]\/[nN]\]|\bpassword\s*:|\bpassphrase\s*:|\bpress any key|\bcontinue\?\s*$|:\s*$)/i.test(s)) return true;
  if (/(?:\blistening on\b|\bserver running\b|\bstarted on\b|\bready in \d+|\bdaemon started\b|"status"\s*:\s*"(?:ok|healthy|running|online)"|"ok"\s*:\s*true|\bhttp:\/\/(?:127\.0\.0\.1|localhost):\d+)/i.test(s)) return true;
  if (s.includes("{") && /\}\s*$/.test(s)) return true;
  return false;
}

module.exports = {
  SAFE_READ_TOOLS,
  WRITE_FILE_TOOLS,
  EXEC_CMD_TOOLS,
  parseToolArg,
  isModelAgnosticReadOnlyTool,
  extractTargetFileFromArgs,
  extractWriteContentFromArgs,
  isPureReadOnlyCommand,
  isWhitelistedTarget,
  isToolCallGated,
  isReadOnlySubagentCall,
  findRawDetailedPathInAskQuestion,
  isUserAuthorized,
  extractAskQuestionPresetOptions,
  evaluateAskQuestionResponse,
  stripArtifactFeedbackFileSync,
  stripArtifactFeedbackButton,
  readTaskLogSnapshot,
  isFastCompletionOrPromptTail
};
