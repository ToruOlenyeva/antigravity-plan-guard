// Antigravity 全局方案审查门禁执行引擎 (plan-guard) · 交互按钮确认架构 (ask_question)
const fs = require("fs");
const path = require("path");

const APPROVED_WINDOW_MS = 60000;

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

function loadState(statePath) {
  try {
    if (statePath && fs.existsSync(statePath)) {
      const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (data && typeof data === "object") return data;
    }
  } catch (e) {}
  return { approved: false, approvedAt: 0 };
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

  // 1. 禁止任何管道或重定向写盘行为
  if (c.indexOf(">") !== -1 || c.indexOf("out-file") !== -1 || c.indexOf("set-content") !== -1 || c.indexOf("add-content") !== -1) {
    return false;
  }

  // 2. 远程 SSH 命令严格审计
  if (c.indexOf("ssh ") !== -1) {
    const remoteMutations = /(sed |tee |rm |mv |cp |docker |systemctl |service |apt |apt-get |yum |dnf |curl |wget |reboot |shutdown |chmod |chown |kill |mkdir |touch )/;
    if (remoteMutations.test(c)) return false;

    const pureRemoteReads = /^(ssh\s+[\s\S]+?["'])(cat|grep|ls|ps|head|tail|find|which|echo|uptime|top|free|df|stat)\b/;
    if (pureRemoteReads.test(c)) return true;

    return false;
  }

  // 3. 本地纯只读查询命令白名单（支持 git -C <path> 前缀）
  const localSafeReads = /^(git\s+(-C\s+("[^"]+"|'[^']+'|\S+)\s+)?(status|log|diff|branch|show)|dir|ls|get-childitem|cat|type|get-content|head|tail|grep|select-string|findstr|npm\s+run\s+test:docs|npm\s+test|cargo\s+check)(\s|$)/;
  if (localSafeReads.test(c)) return true;

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
    const qs = parseToolArg(tc.args.questions);
    if (!Array.isArray(qs)) continue;
    for (const q of qs) {
      if (q && Array.isArray(q.options)) {
        for (const opt of q.options) {
          if (typeof opt === "string" && opt.trim()) {
            preset.add(opt.trim());
          }
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

  for (const ans of answerLines) {
    if (!ans || /^(skipped|canceled|cancelled)$/i.test(ans)) {
      return { isAskResponse: true, approved: false, isWriteIn: false };
    }
    if (rejectSignals.test(ans)) {
      return { isAskResponse: true, approved: false, isWriteIn: false };
    }
    if (!presetOptions || presetOptions.size === 0) {
      return { isAskResponse: true, approved: false, isWriteIn: true };
    }
    if (!presetOptions.has(ans)) {
      const parts = ans.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
      const allPartsInPreset = parts.length > 1 && parts.every((p) => presetOptions.has(p));
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

function handlePreToolUse(payload) {
  try {
    const userLang = detectUserLang(payload.transcriptPath);
    const toolCall = payload.toolCall || {};
    const toolName = toolCall.name || "";
    const args = toolCall.args || {};

    // 阶段 1 & 2：模型无关纯只读工具、后台状态查询与只读子智能体直接放行（ask_question 需通过阶段 5 审计后再放行）
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

    // 阶段 4：终端命令只读审计（兼容 run_command 与 Bash）
    if (EXEC_CMD_TOOLS.has(toolName)) {
      const cmd = String(args.CommandLine || args.command || "").trim();
      if (isPureReadOnlyCommand(cmd)) {
        return reply({ decision: "allow" });
      }
    }

    // 阶段 5：状态机扫描对话历史（区分主智能体与子智能体；主智能体统一通过 ask_question 按钮确认）
    const statePath = getStatePath(payload.transcriptPath);
    const state = loadState(statePath);
    const now = Date.now();
    const isStateWindowValid = Boolean(state.approved && (now - (state.approvedAt || 0) <= APPROVED_WINDOW_MS));

    let tPath = payload.transcriptPath || "";
    const fullPath = tPath.endsWith("transcript.jsonl")
      ? tPath.replace(/transcript\.jsonl$/, "transcript_full.jsonl")
      : tPath;
    if (tPath.endsWith("transcript_full.jsonl")) {
      const compact = tPath.replace("transcript_full.jsonl", "transcript.jsonl");
      if (fs.existsSync(compact)) tPath = compact;
    }
    if (!tPath || !fs.existsSync(tPath)) {
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

    const fd = fs.openSync(tPath, "r");
    const stats = fs.fstatSync(fd);
    let hasUserInputInHead = false;
    if (stats.size > 1048576) {
      const headSize = Math.min(stats.size, 65536);
      const headBuf = Buffer.alloc(headSize);
      fs.readSync(fd, headBuf, 0, headSize, 0);
      const headStr = headBuf.toString("utf-8");
      if (/"source"\s*:\s*"USER_EXPLICIT"|"type"\s*:\s*"USER_INPUT"/.test(headStr)) {
        hasUserInputInHead = true;
      }
    }
    const readSize = Math.min(stats.size, 1048576);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);

    const chunk = buffer.toString("utf-8");
    const lines = chunk.trim().split("\n");

    let isApproved = false;
    let hasPlanSinceLastReset = false;
    let hasAssistantContentSinceLastReset = false;
    let currentAskStepFound = false;
    let currentAskStepHasContent = false;
    let lastResetReason = "initial";
    let pendingToolCalls = [];
    let pendingStepIndex = -1;
    let hasUserInput = hasUserInputInHead;
    let hasParentSenderMessage = false;

    for (let i = 0; i < lines.length; i++) {
      try {
        const e = JSON.parse(lines[i]);
        const content = e.content || "";

        if (e.source === "USER_EXPLICIT" || e.type === "USER_INPUT") {
          hasUserInput = true;
          pendingToolCalls = [];
          pendingStepIndex = -1;
          hasPlanSinceLastReset = false;
          hasAssistantContentSinceLastReset = false;
          currentAskStepFound = false;
          currentAskStepHasContent = false;
          if (isUserAuthorized(content)) {
            isApproved = true;
            state.approved = true;
            state.approvedAt = now;
            saveState(statePath, state);
          } else {
            isApproved = false;
            state.approved = false;
            saveState(statePath, state);
            lastResetReason = "user_input";
          }
          continue;
        }

        if (e.type === "SYSTEM_MESSAGE" || e.source === "SYSTEM") {
          currentAskStepFound = false;
          currentAskStepHasContent = false;
          if (/\[Message\]\s+timestamp=[^\r\n]+?\s+sender=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(content)) {
            hasParentSenderMessage = true;
          }
          if (isUserAuthorized(content)) {
            isApproved = true;
          }
          continue;
        }

        if (e.type === "PLANNER_RESPONSE") {
          const visibleText = typeof e.content === "string" ? e.content.trim() : "";
          if (visibleText.length > 0) {
            hasAssistantContentSinceLastReset = true;
          }
          if (Array.isArray(e.tool_calls)) {
            pendingToolCalls = e.tool_calls;
            pendingStepIndex = typeof e.step_index === "number" ? e.step_index : -1;
            const callsAsk = e.tool_calls.some((tc) => tc && tc.name === "ask_question");
            if (callsAsk) {
              currentAskStepFound = true;
              currentAskStepHasContent = visibleText.length > 0;
            }
            for (const tc of e.tool_calls) {
              if (tc && WRITE_FILE_TOOLS.has(tc.name) && tc.args) {
                const tf = extractTargetFileFromArgs(tc.args).replace(/\\/g, "/").toLowerCase();
                if (tf.endsWith("implementation_plan.md")) {
                  hasPlanSinceLastReset = true;
                }
              }
            }
          }
          continue;
        }

        if (e.type === "GENERIC") {
          currentAskStepFound = false;
          currentAskStepHasContent = false;
          if (
            e.status === "DONE" &&
            content.indexOf("Encountered error") === -1 &&
            /(Created file|replace_file_content tool to:|Wrote to|Edited file|Made \d+ replacement)[^\r\n]*implementation_plan\.md/i.test(content)
          ) {
            hasPlanSinceLastReset = true;
          }

          let presetOpts = extractAskQuestionPresetOptions(pendingToolCalls);
          if (presetOpts.size === 0 && pendingStepIndex >= 0 && fullPath && fs.existsSync(fullPath)) {
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
                  if (fe.step_index === pendingStepIndex && Array.isArray(fe.tool_calls)) {
                    presetOpts = extractAskQuestionPresetOptions(fe.tool_calls);
                    break;
                  }
                } catch (e2) {}
              }
            } catch (e3) {}
          }

          const askEval = evaluateAskQuestionResponse(content, presetOpts);
          if (askEval.isAskResponse) {
            hasPlanSinceLastReset = false;
            hasAssistantContentSinceLastReset = false;
            if (askEval.approved) {
              isApproved = true;
              state.approved = true;
              state.approvedAt = now;
              saveState(statePath, state);
            } else {
              isApproved = false;
              state.approved = false;
              saveState(statePath, state);
              lastResetReason = askEval.isWriteIn ? "write_in" : "ask_rejected";
            }
            pendingToolCalls = [];
            pendingStepIndex = -1;
            continue;
          }
        }
      } catch (err) {}
    }

    // 子智能体会话识别：无人类直接输入（USER_EXPLICIT）且由父智能体 SYSTEM_MESSAGE (sender=<UUID>) 唤醒
    const isSubagent = !hasUserInput && hasParentSenderMessage;
    if (isSubagent) {
      if (toolName === "ask_question") {
        return reply({
          decision: "deny",
          reason: userLang === "zh"
            ? "【子智能体免弹窗直通】当前会话是由主智能体（Parent Agent）委派的子智能体，主智能体在派单前已取得用户按钮确认！子智能体严禁调用 ask_question 阻塞等待用户输入，请直接按主智能体下发的施工图并发执行文件读写与终端命令。"
            : "[Subagent Direct Execution] This conversation is a subagent delegated by the Parent Agent, which has already obtained user button confirmation! Subagents are STRICTLY FORBIDDEN from calling ask_question to block execution. Directly execute file operations and terminal commands concurrently per the plan."
        });
      }
      return reply({ decision: "allow" });
    }

    // 针对主智能体 ask_question 本身的「必先输出聊天正文解释」「防折叠藏匿」与「分级展示」审计
    if (toolName === "ask_question") {
      if ((currentAskStepFound && !currentAskStepHasContent) || (!currentAskStepFound && !hasAssistantContentSinceLastReset)) {
        return reply({
          decision: "deny",
          reason: userLang === "zh"
            ? "【方案门禁拦截 · 严禁无正文裸调弹窗】检测到你在调用 ask_question 的当前回合未输出任何聊天正文解释（content 字段为空），导致用户只能看到干巴巴的修改弹窗而看不到原因分析与解释！请在同一回合中先在聊天正文（content）输出完整的分析与解释说明，再同时调用 ask_question（question 窗口仅列纯修改方案与文件芯片）。"
            : "[Plan Guard Intercept | Empty Content Forbidden] Calling ask_question with empty chat content is blocked! The user must see the rationale and analysis in chat before the popup. Please output full explanations in chat body (content) first in the same turn, and simultaneously call ask_question (keep question window focused on modification plan and file chips)."
        });
      }
      const qs = parseToolArg(args.questions);
      if (Array.isArray(qs)) {
        const lazyRefRegex = /(详见正文|见正文|如上所述|见上方|详见上方|同正文|方案见正文|详见方案|见方案|见上文|参考正文|参考上文|详见\s*implementation_plan|see above|see chat|as described above|refer to above|see details above|same as above)/i;
        for (const q of qs) {
          const qText = String((q && q.question) || "");
          if (lazyRefRegex.test(qText)) {
            return reply({
              decision: "deny",
              reason: userLang === "zh"
                ? "【方案门禁拦截 · 严禁折叠藏匿与冗余指代】严禁在 question 中写「详见正文/详见方案/详见 implementation_plan.md」等占位词！请在同一回合先输出聊天正文（content）解释，并将【纯修改方案（待修改的 [文件名](file:///...) 芯片及具体改动点）】直接写在 ask_question 的 question 窗口中，options 选项只放极简动作按钮（如「(Recommended) 确认执行」「采用方案 A」「暂不修改」，严禁在 options 中重复抄写方案），然后重新调用 ask_question。"
                : "[Plan Guard Intercept | Lazy References Forbidden] Using placeholders like 'see above / refer to plan / see implementation_plan.md' in question is forbidden! Output analysis in chat body (content) first, and put the pure modification plan (target [filename](file:///...) chips and specific changes) directly in the ask_question modal. Keep options strictly to concise action buttons (e.g., '(Recommended) Confirm & Execute', 'Cancel'; never duplicate plan text in options), then call ask_question again."
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
      return reply({ decision: "allow" });
    }

    // 分支 1：已通过 ask_question 预设选项点击或明确授权，或处于 60s 滑动续期窗口 -> 直接放行并刷新滑动窗口
    if (isApproved || isStateWindowValid) {
      state.approved = true;
      state.approvedAt = now;
      saveState(statePath, state);
      return reply({ decision: "allow" });
    }

    // 分支 2：用户在 ask_question 中使用了自定义输入（Write-In 提示词补充），模型尚未重新调用 ask_question 获得确认
    if (lastResetReason === "write_in") {
      return reply({
        decision: "deny",
        reason: userLang === "zh"
          ? "【方案门禁拦截 · Write-In 提示词补充】检测到用户在 ask_question 中自行输入了文字（Write-In），这属于提示词补充而非确认！请先在同一回合的聊天正文（content）中回应用户的补充要求并说明调整原因，同时再次调用 ask_question（在 question 窗口中直接列出更新后的纯修改方案，options 只放极简确认按钮）供用户确认。"
          : "[Plan Guard Intercept | Write-In Prompt Refinement] User input custom text (Write-In) in ask_question, which represents prompt refinement rather than confirmation! Please address the user feedback and rationale in chat content first, and call ask_question again (list updated pure modification plan in question, concise buttons in options) for user confirmation."
      });
    }

    // 分支 3：已生成 implementation_plan.md 但尚未调用 ask_question 取得用户按钮确认 -> 拦截同回合抢跑
    if (hasPlanSinceLastReset) {
      return reply({
        decision: "deny",
        reason: userLang === "zh"
          ? "【方案门禁拦截 · 等待按钮确认】已生成 implementation_plan.md 大卡片，但尚未通过 ask_question 征得用户按钮确认！请在同一回合先输出聊天正文解释（content），并同时调用 ask_question 弹出确认面板：在 question 窗口中直接列出核心修改方案与目标业务文件芯片（严禁塞入原理解释，严禁写「详见正文/详见 implementation_plan.md」），options 仅放极简动作按钮（如「(Recommended) 确认执行」「暂不修改」，严禁复读方案），等待用户勾选提交后再执行修改。"
          : "[Plan Guard Intercept | Awaiting Button Confirmation] implementation_plan.md artifact generated, but user button confirmation via ask_question has not been obtained! In the same turn, output explanations in chat content first, and call ask_question to present the confirmation modal: list core modification plan and target business file chips in question directly (no rationale dumping, no 'see above'), keep options as concise action buttons (e.g., '(Recommended) Confirm & Execute', 'Cancel'), and wait for user submission before modifying."
      });
    }

    // 分支 4：尚未调用 ask_question 确认 -> 阻断并引导模型按分级策略调用 ask_question
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

    const zhReason = "【方案门禁拦截 · 零信任白名单】检测到尚未通过按钮确认即尝试执行" + actionDesc + "（工具：" + toolName + "）。请按任务复杂度分级触发 ask_question 按钮确认（严禁无正文裸调弹窗，严禁让用户手动打字回复「确认」，严禁不写方案只写「详见正文/详见方案」）：1) 同回合先正文解释再弹窗：调用 ask_question 的同一回合必须先在聊天正文（content）输出完整的原因分析与原理解释，ask_question 的 question 窗口直接列出【纯修改方案（待修改的 [文件名](file:///...) 芯片及具体改动点）】；2) 简单任务（≤3文件）免写 implementation_plan.md（不弹大卡片），复杂任务（>3文件或多方案架构）先写 implementation_plan.md（可在 question 标题旁附带 [implementation_plan.md](file:///...) 芯片供弹窗期点击预览，且回合结束后底部自动挂载 Implementation Plan 大卡片）；3) 选项零复读：options 仅放极简动作按钮（单方案用「(Recommended) 确认执行 / 暂不修改」，多方案用「(Recommended) 采用方案 A / 采用方案 B / 暂不修改」），严禁在 options 中重复抄写方案内容！";

    const enReason = "[Plan Guard Intercept | Zero-Trust Whitelist] Attempted " + actionDescEn + " (tool: " + toolName + ") before user button confirmation! Trigger ask_question button confirmation graded by complexity (no empty-content popups, no asking user to type 'confirm' manually, no lazy 'see above' references): 1) Chat explanation before popup in same turn: output full analysis and rationale in chat content first, list pure modification plan and target [filename](file:///...) chips directly in ask_question modal; 2) Skip implementation_plan.md for simple tasks (<=3 files); generate implementation_plan.md for complex tasks (>3 files) and attach [implementation_plan.md](file:///...) chip in question; 3) Zero-duplication options: keep options strictly to concise action buttons (single option: [\"(Recommended) Confirm & Execute\", \"Cancel\"]; multiple options: [\"(Recommended) Option A\", \"Option B\", \"Cancel\"]); never copy plan text into options!";

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
    // 60s 滑动续期窗口：当非 ask_question 的受控工具或 call_mcp_tool 执行完毕且当前 state.approved 为 true 时刷新
    const statePath = getStatePath(payload.transcriptPath);
    const state = loadState(statePath);
    if (state.approved && toolName !== "ask_question") {
      state.approvedAt = Date.now();
      saveState(statePath, state);
    }
  } catch (e) {}
  return reply({});
}

function handlePreInvocation(payload) {
  const userLang = detectUserLang(payload && payload.transcriptPath);
  const zhMessage = "【方案门禁在线（主智能体单点确认 · 子智能体免弹窗直通）】1) 若当前会话是由主智能体通过 invoke_subagent 委派的子智能体（Subagent，即收到 <SYSTEM_MESSAGE> [Message] ... sender=... 指令），主智能体在派单前已完成用户确认，子智能体【严禁调用 ask_question 弹窗阻塞】，必须直接按施工图并发执行文件读写与终端验证！2) 若当前会话为直接面向用户的【主智能体（Main Agent）】，执行任何代码/文档修改或派发写盘子智能体前，必须通过 ask_question 弹出按钮卡片暂停确认，并遵守三项 UI 铁律：a) 同回合先正文解释再弹窗（调用 ask_question 的同一回合必须在聊天正文 content 中先输出完整的原因分析与解释说明，严禁无正文裸调弹窗；question 窗口直接列出【纯修改方案】与目标业务文件 [文件名](file:///...) 芯片；简单任务免写 implementation_plan.md 不弹大卡片，复杂任务先写 implementation_plan.md 并在 question 标题旁附 [implementation_plan.md](file:///...) 芯片供弹窗期预览，回合结束时底部自动挂载 Implementation Plan 大卡片，严禁不写方案只写「详见正文/方案」）；b) 选项只做极简按钮（单方案：[\"(Recommended) 确认执行\", \"暂不修改\"]；多方案：[\"(Recommended) 采用方案 A\", \"采用方案 B\", \"暂不修改\"]，严禁在 options 中重复抄写方案）；c) Write-In 自定义输入视为提示词补充，须在聊天正文回应并调整方案后再次调用 ask_question 确认！";
  const enMessage = "[Plan Guard Online (Main Agent Single-Point Confirmation | Subagents Bypass)] 1) If the current conversation is a subagent delegated by the main agent via invoke_subagent (received <SYSTEM_MESSAGE> [Message] ... sender=... instruction), the main agent has already obtained user confirmation. Subagents are STRICTLY FORBIDDEN from calling ask_question to block for user input; proceed directly with concurrent file operations and terminal verifications per the plan! 2) If the current conversation is the user-facing Main Agent, before executing any code/document mutations or dispatching mutating subagents, you MUST call ask_question to pause for button confirmation, adhering to three UI rules: a) Provide chat body explanation before popup in the same turn (always output full analysis and rationale in chat content first; never call ask_question with empty content. Place pure modification plan and target [filename](file:///...) chips directly in the question window. Skip implementation_plan.md for simple tasks <=3 files; write implementation_plan.md for complex tasks >3 files and include [implementation_plan.md](file:///...) chip in question. Never say 'see above/refer to plan'); b) Use concise action options only (single option: [\"(Recommended) Confirm & Execute\", \"Cancel\"]; multiple options: [\"(Recommended) Option A\", \"Option B\", \"Cancel\"]; never duplicate plan details in options); c) Treat custom write-in input as prompt refinement; address it in chat content and call ask_question again for approval!";
  return reply({
    injectSteps: [{
      ephemeralMessage: userLang === "zh" ? zhMessage : enMessage
    }]
  });
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
  if (mode === "pre-invocation") handlePreInvocation(payload);
  else if (mode === "post-tool") handlePostToolUse(payload);
  else handlePreToolUse(payload);
}

main();
