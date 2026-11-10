// Antigravity 全局方案审查门禁执行引擎 (plan-guard) · 四事件主入口与门禁调度器
const fs = require("fs");
const path = require("path");
const auditMod = require("./lib/read-only-audit.cjs");
const grantsMod = require("./lib/workspace-grants.cjs");
const stateMod = require("./lib/transcript-state.cjs");
const { WRITE_FILE_TOOLS, EXEC_CMD_TOOLS, parseToolArg, isModelAgnosticReadOnlyTool, extractTargetFileFromArgs, isPureReadOnlyCommand, isWhitelistedTarget, isReadOnlySubagentCall, findRawDetailedPathInAskQuestion } = auditMod;
const { resolveHostHomeDir, normalizePathForMatch, createEmptyGrants, mergeGrants, extractConvId, extractScopeGrantsFromPlan, readCurrentConversationPlanArtifact, verifyToolCallAgainstApprovedGrants } = grantsMod;
const { saveState, resolveAndLockWorkspaceRoots, syncTranscriptState, stripArtifactFeedbackFileSync, stripArtifactFeedbackButton, readTaskLogSnapshot, isFastCompletionOrPromptTail } = stateMod;

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

function handlePreToolUse(payload) {
  try {
    const homeDir = resolveHostHomeDir();
    const userLang = detectUserLang(payload.transcriptPath);
    const toolCall = payload.toolCall || {};
    const toolName = toolCall.name || "";
    const args = toolCall.args || {};

    const synced = syncTranscriptState(payload.transcriptPath, payload);
    const state = synced.state;
    const workspaceRoots = resolveAndLockWorkspaceRoots(payload, state, synced.statePath, payload.transcriptPath);

    // 阶段 1 & 2：全盘只读放行（纯只读工具、后台状态查询与只读子智能体不限工作区内外直接放行；ask_question 需通过阶段 5 审计后再放行）
    if (toolName !== "ask_question" && isModelAgnosticReadOnlyTool(toolName, args)) {
      if (toolName === "manage_task" && args && typeof args === "object") {
        const act = String(args.Action || args.action || "").toLowerCase();
        const tid = String(args.TaskId || args.taskId || args.task_id || "").trim();
        if (act === "kill" && tid && state.activeBgTasks) {
          let removed = false;
          for (const k of Object.keys(state.activeBgTasks)) {
            if (k === tid || k.endsWith("/" + tid) || tid.endsWith("/" + k)) {
              delete state.activeBgTasks[k];
              removed = true;
            }
          }
          if (removed) saveState(synced.statePath, state);
        }
      }
      return reply({ decision: "allow" });
    }
    if ((toolName === "invoke_subagent" || toolName === "Task") && isReadOnlySubagentCall(args)) {
      return reply({ decision: "allow" });
    }

    // 阶段 3：方案工件与调试目录放行
    if (WRITE_FILE_TOOLS.has(toolName)) {
      const rawTarget = extractTargetFileFromArgs(args);
      const targetFile = rawTarget.replace(/\\/g, "/");
      if (isWhitelistedTarget(targetFile)) {
        stripArtifactFeedbackButton(rawTarget, true, __filename);
        return reply({ decision: "allow" });
      }
    }

    // 阶段 4：终端命令只读审计
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

    // 阶段 5：针对主智能体 ask_question 本身的「必先输出聊天正文解释」「防折叠藏匿」「拦截裸盘符路径」与「后台自动提取申请权限」
    if (toolName === "ask_question") {
      if ((state.currentAskStepFound && !state.currentAskStepHasContent) || (!state.currentAskStepFound && !state.hasAssistantContentSinceLastReset)) {
        return reply({
          decision: "deny",
          reason: userLang === "zh"
            ? "【方案门禁拦截 · 严禁无正文裸调弹窗】检测到你在调用 ask_question 的当前回合未输出任何聊天正文解释（content 字段为空），导致用户只能看到干巴巴的修改弹窗而看不到原因分析与解释！请在同一回合中先在聊天正文（content）输出完整的分析与解释说明，再同时调用 ask_question（question 窗口仅列纯修改方案与简短项目/插件名）。"
            : "[Plan Guard Intercept | Empty Content Forbidden] Calling ask_question with empty chat content is blocked! The user must see the rationale and analysis in chat before the popup. Please output full explanations in chat body (content) first in the same turn, and simultaneously call ask_question (keep question window focused on modification plan and concise project/plugin names)."
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
                ? "【方案门禁拦截 · 严禁折叠藏匿与冗余指代】严禁在 question 中写「详见正文/详见方案/详见 implementation_plan.md」等占位词！请在同一回合先输出聊天正文（content）解释，并将【纯修改方案（说明改哪些内容，以及改哪些工作区外的项目名/插件名）】直接写在 ask_question 的 question 窗口中，options 选项只放极简动作按钮（如「(Recommended) 确认执行」「采用方案 A」「暂不修改」，严禁在 options 中重复抄写方案），然后重新调用 ask_question。"
                : "[Plan Guard Intercept | Lazy References Forbidden] Using placeholders like 'see above / refer to plan / see implementation_plan.md' in question is forbidden! Output analysis in chat body (content) first, and put the pure modification plan (what will be modified and which out-of-workspace project/plugin names are involved) directly in the ask_question modal. Keep options strictly to concise action buttons (e.g., '(Recommended) Confirm & Execute', 'Cancel'), then call ask_question again."
            });
          }
          const rawPathExposed = findRawDetailedPathInAskQuestion(qText);
          if (rawPathExposed) {
            return reply({
              decision: "deny",
              reason: userLang === "zh"
                ? "【方案门禁拦截 · 严禁在弹窗中裸写详细路径】检测到 ask_question 的 question 文本中直接暴露了冗长的路径（\"" + rawPathExposed + "\"）！向用户展示的弹窗方案只需写明简短的项目名/插件名/模块名（例如「修改 antigravity-relay 插件」）或使用 [文件名](file:///...) 芯片（后台会自动从项目名、插件名、同回合正文芯片及 implementation_plan.md 中映射外部目录权限，且 brain/<id>/scratch 临时目录免申报），请去掉裸露的详细路径后重新调用 ask_question！"
                : "[Plan Guard Intercept | Raw Detailed Paths Forbidden in Modal] Detected raw filesystem path (\"" + rawPathExposed + "\") directly exposed in ask_question text! In the user-facing modal, only write concise project/plugin/module names (e.g., 'modify antigravity-relay plugin') or [filename](file:///...) Markdown chips (background automatically resolves project/plugin names and chips into external directory grants, and brain/<id>/scratch temp directories require no declaration). Please remove raw paths and call ask_question again!"
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
      if (state.lastAssistantContent) {
        askPlanTexts.push(state.lastAssistantContent);
      }
      const refsPlan = askPlanTexts.some((t) => /implementation_plan\.md/i.test(t));
      const planArtifactText = readCurrentConversationPlanArtifact(payload.transcriptPath, state.hasPlanSinceLastReset || refsPlan);
      if (planArtifactText) askPlanTexts.push(planArtifactText);
      state.pendingGrants = mergeGrants(state.pendingGrants, extractScopeGrantsFromPlan(askPlanTexts, workspaceRoots, homeDir));
      saveState(synced.statePath, state);
      return reply({ decision: "allow" });
    }

    // 分支 1：已通过 ask_question 预设选项点击或明确授权 -> 按本轮获批权限范围精准放行
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
        return reply({ decision: "deny", reason: scopeCheck.reason });
      }
      return reply({ decision: "allow" });
    }

    // 分支 2：用户在 ask_question 中使用了自定义输入（Write-In 提示词补充）
    if (state.lastResetReason === "write_in") {
      return reply({
        decision: "deny",
        reason: userLang === "zh"
          ? "【方案门禁拦截 · Write-In 提示词补充】检测到用户在 ask_question 中自行输入了文字（Write-In），这属于提示词补充而非确认！请先在同一回合的聊天正文（content）中回应用户的补充要求并说明调整原因，同时再次调用 ask_question（在 question 窗口中直接列出更新后的纯修改方案，options 只放极简确认按钮）供用户确认。"
          : "[Plan Guard Intercept | Write-In Prompt Refinement] User input custom text (Write-In) in ask_question, which represents prompt refinement rather than confirmation! Please address the user feedback and rationale in chat content first, and call ask_question again (list updated pure modification plan in question, concise buttons in options) for user confirmation."
      });
    }

    // 分支 3：已生成 implementation_plan.md 但尚未调用 ask_question 取得用户按钮确认
    if (state.hasPlanSinceLastReset) {
      return reply({
        decision: "deny",
        reason: userLang === "zh"
          ? "【方案门禁拦截 · 等待按钮确认】已生成 implementation_plan.md 大卡片，但尚未通过 ask_question 征得用户按钮确认！请在同一回合先输出聊天正文解释（content），并同时调用 ask_question 弹出确认面板：在 question 窗口中直接列出核心修改方案（说明改哪些内容、若涉及工作区外需写明工作区外项目名/插件名，严禁裸写详细盘符路径，后台会自动申请对应修改工具与路径权限），options 仅放极简动作按钮（如「(Recommended) 确认执行」「暂不修改」），等待用户勾选提交后再执行修改。"
          : "[Plan Guard Intercept | Awaiting Button Confirmation] implementation_plan.md artifact generated, but user button confirmation via ask_question has not been obtained! In the same turn, output explanations in chat content first, and call ask_question to present the confirmation modal: list core modification plan and any out-of-workspace project/plugin names in question directly (never expose raw full paths; background automatically requests tool and path permissions), keep options as concise action buttons (e.g., '(Recommended) Confirm & Execute', 'Cancel'), and wait for user submission before modifying."
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

    const zhReason = "【方案门禁拦截 · 按单申请与工作区内外把控】检测到尚未通过按钮确认即尝试执行" + actionDesc + "（工具：" + toolName + "）。出方案前允许全盘调用只读工具免弹窗调研；执行任何修改前，必须同回合先在聊天正文（content）输出完整原因分析，再调用 ask_question 列出【纯修改方案】（若涉及工作区外修改只需写明外部项目名或插件名，严禁裸写 C:/Users/... 等详细路径，brain/<id>/scratch 免申报；复杂任务先写 implementation_plan.md）；options 仅放极简按钮（如 [\"(Recommended) 确认执行\", \"暂不修改\"]）。";

    const enReason = "[Plan Guard Intercept | Scoped Permission Application] Attempted " + actionDescEn + " (tool: " + toolName + ") before user button confirmation! Full-disk read-only tools are allowed during research; before any modification, output full analysis in chat content first and call ask_question in the same turn with the pure modification plan (state external project/plugin names without raw full paths; brain/<id>/scratch is exempt); keep options to concise buttons ([\"(Recommended) Confirm & Execute\", \"Cancel\"]).";

    return reply({
      decision: "deny",
      reason: userLang === "zh" ? zhReason : enReason
    });
  } catch (e) {
    return reply({ decision: "allow" });
  }
}

function handlePostToolUse(payload) {
  try {
    const toolCall = payload.toolCall || {};
    const toolName = toolCall.name || "";
    const args = toolCall.args || {};
    if (WRITE_FILE_TOOLS.has(toolName)) {
      const rawTarget = extractTargetFileFromArgs(args);
      if (isWhitelistedTarget(rawTarget)) {
        stripArtifactFeedbackButton(rawTarget, false, __filename);
      }
    }
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
  const zhMessage = "【方案门禁在线（全盘只读免弹窗 · 按单申请修改与跨区权限 · 弹窗禁裸写长路径）】" + wsHintZh + " 1) 出方案前允许全盘调用任意只读工具（read_file/list_dir/grep_search/只读终端命令/research 子智能体）免弹窗勘测；2) 若当前会话是由主智能体委派的子智能体（Subagent，含 sender=<UUID>），严禁调用 ask_question 弹窗阻塞，直接在主智能体已获批的工作区与外部路径范围内并发执行！3) 若当前会话为主智能体（Main Agent），执行任何修改前必须同回合先输出聊天正文解释（content）再调用 ask_question 列出【纯修改方案】：方案中说明要改哪些内容（无需写明具体修改工具名，后台自动申请修改工具权限）；若涉及修改当前工作区外的内容，只需在方案中写明要改哪些工作区外的项目名或插件名（如「修改 antigravity-relay 插件」，严禁在 ask_question 文本中裸写 C:/Users/... 等详细绝对路径，且 brain/<id>/scratch 临时目录默认免申报，后台会自动从项目名、插件名及正文 [文件名](file:///...) 芯片映射外部目录权限）；options 仅放极简按钮（如 [\"(Recommended) 确认执行\", \"暂不修改\"]）。用户同意后自动放行已申请范围，未申请的工作区外修改将被严格拦截！";
  const enMessage = "[Plan Guard Online (Full-Disk Read Free | Scoped Mutation & External Grants | No Raw Paths in Modal)]" + wsHintEn + " 1) Full-disk read-only tools (read_file/list_dir/grep_search/read-only commands/research subagent) are allowed without popups before proposing a plan; 2) If this conversation is a Subagent (woken by sender=<UUID>), NEVER call ask_question; execute directly within the parent's approved workspace and external path scope! 3) If this is the Main Agent, before any modification, output full explanation in chat content first and call ask_question in the same turn to list the pure modification plan: explain what will be modified (no need to list specific tool names; background automatically requests mutation tool permissions); if modifying anything outside the current workspace, state only the external project or plugin name (e.g., 'modify antigravity-relay plugin'—NEVER write raw full filesystem paths like C:/Users/... in ask_question text, and brain/<id>/scratch temp files require no declaration; background automatically resolves project/plugin names and [filename](file:///...) chips); keep options to concise buttons ([\"(Recommended) Confirm & Execute\", \"Cancel\"]). Approved scopes are allowed while undeclared external paths remain strictly blocked!";
  return reply({
    injectSteps: [{
      ephemeralMessage: userLang === "zh" ? zhMessage : enMessage
    }]
  });
}

async function handleStop(payload) {
  try {
    if (payload && payload.transcriptPath) {
      const synced = syncTranscriptState(payload.transcriptPath, payload);
      const reason = String(payload.terminationReason || "");
      if (reason === "USER_CANCELED" || (reason === "NO_TOOL_CALL" && payload.fullyIdle === true)) {
        const isSubagent = !synced.state.hasUserInput && synced.state.hasParentSenderMessage;
        if (reason === "NO_TOOL_CALL" && payload.fullyIdle === true && !isSubagent) {
          const wakeupCount = Number(synced.state.outerReplyWakeupCount) || 0;
          const toolCallsInTurn = Number(synced.state.turnToolCallCount) || 0;
          const lastHasTools = Boolean(synced.state.lastPlannerStepHasToolCalls);
          const finalLen = Number(synced.state.lastPlannerStepContentLen) || 0;
          const foldedLen = Number(synced.state.foldedToolStepSubstantiveLen) || 0;
          const hasFoldedMarkers = Boolean(synced.state.foldedToolStepHasFinalReportMarkers);

          const emptyFinalReplyAfterTools = toolCallsInTurn > 0 && (lastHasTools || finalLen === 0);
          const reportSwallowedInToolStep =
            (hasFoldedMarkers || foldedLen >= 240) &&
            finalLen < Math.min(120, Math.floor(foldedLen * 0.5));

          if (wakeupCount < 1 && (emptyFinalReplyAfterTools || reportSwallowedInToolStep)) {
            synced.state.outerReplyWakeupCount = wakeupCount + 1;
            synced.state.foldedToolStepSubstantiveLen = 0;
            synced.state.foldedToolStepHasFinalReportMarkers = false;
            saveState(synced.statePath, synced.state);
            const userLang = detectUserLang(payload.transcriptPath);
            return reply({
              decision: "continue",
              reason: userLang === "zh"
                ? "【折叠外回复守卫（Stop Hook 强控）】检测到你在本轮中将正式回复/结案汇报与工具调用混发在同一回合（导致回复正文被宿主折叠进 Worked for ... > 内部），或回合结束步未输出任何正文（折叠块外无气泡）！请立即在不调用任何工具的纯文本回合中，将面向用户的完整正式回复重新输出一遍，确保回复气泡 100% 呈现在 Worked for ... > 折叠块外部。"
                : "[Outer Reply Guard (Stop Hook)] Detected that your formal response/final report was mixed with tool calls in the same step (causing it to be collapsed inside 'Worked for ... >'), or the final step had empty content! Please immediately output the complete user-facing response in a pure-text turn WITHOUT calling any tools, ensuring the reply bubble renders outside the collapsed block."
            });
          }
        }

        synced.state.approved = false;
        synced.state.approvedStepIndex = -1;
        synced.state.pendingGrants = createEmptyGrants();
        synced.state.approvedGrants = createEmptyGrants();
        synced.state.activeBgTasks = {};
        synced.state.turnToolCallCount = 0;
        synced.state.lastPlannerStepHasToolCalls = false;
        synced.state.lastPlannerStepContentLen = 0;
        synced.state.foldedToolStepSubstantiveLen = 0;
        synced.state.foldedToolStepHasFinalReportMarkers = false;
        synced.state.outerReplyWakeupCount = 0;
        saveState(synced.statePath, synced.state);
        return reply({ decision: "allow" });
      }

      if (reason === "NO_TOOL_CALL" && payload.fullyIdle === false && synced.state.activeBgTasks) {
        const brainDir = path.dirname(path.dirname(path.dirname(path.normalize(String(payload.transcriptPath)))));
        const pollMs = Math.max(100, Number(process.env.PLAN_GUARD_POLL_MS) || 1000);
        const fastStagnantMs = Math.max(200, Number(process.env.PLAN_GUARD_FAST_STAGNANT_MS) || 4000);
        const postOutputStagnantMs = Math.max(300, Number(process.env.PLAN_GUARD_POST_OUTPUT_STAGNANT_MS) || 10000);
        const initialStagnantMs = Math.max(400, Number(process.env.PLAN_GUARD_STAGNANT_MS) || 15000);
        const maxWatchMs = Math.max(1000, Number(process.env.PLAN_GUARD_MAX_WATCH_MS) || 165000);

        const trackers = new Map();
        for (const [tid, info] of Object.entries(synced.state.activeBgTasks)) {
          if (!info || (Number(info.wakeupCount) || 0) >= 3) continue;
          const resolvedLog = info.logPath || path.join(brainDir, ".system_generated", "tasks", tid + ".log");
          const snap = readTaskLogSnapshot(resolvedLog);
          trackers.set(tid, {
            taskId: tid,
            toolSummary: String(info.toolSummary || ""),
            logPath: resolvedLog,
            lastSize: snap.size,
            lastGrowthAt: Date.now(),
            tailText: snap.tailText
          });
        }

        if (trackers.size > 0) {
          const watchStart = Date.now();
          while (Date.now() - watchStart < maxWatchMs) {
            await new Promise((r) => setTimeout(r, pollMs));
            const latest = syncTranscriptState(payload.transcriptPath, payload);
            const activeMap = (latest.state && latest.state.activeBgTasks) || {};

            for (const tid of Array.from(trackers.keys())) {
              const latestInfo = activeMap[tid];
              if (!latestInfo || (Number(latestInfo.wakeupCount) || 0) >= 3) {
                trackers.delete(tid);
              }
            }
            if (trackers.size === 0) {
              return reply({ decision: "allow" });
            }

            const now = Date.now();
            for (const [tid, tracker] of trackers.entries()) {
              const snap = readTaskLogSnapshot(tracker.logPath);
              if (snap.size > tracker.lastSize) {
                tracker.lastSize = snap.size;
                tracker.lastGrowthAt = now;
                tracker.tailText = snap.tailText;
                continue;
              }

              const stagnantMs = now - tracker.lastGrowthAt;
              const isFastTail = snap.size > 0 && isFastCompletionOrPromptTail(snap.tailText);
              const thresholdMs = isFastTail
                ? fastStagnantMs
                : (snap.size > 0 ? postOutputStagnantMs : initialStagnantMs);

              if (stagnantMs >= thresholdMs) {
                if (latest.state.activeBgTasks && latest.state.activeBgTasks[tid]) {
                  latest.state.activeBgTasks[tid].wakeupCount = (Number(latest.state.activeBgTasks[tid].wakeupCount) || 0) + 1;
                  saveState(latest.statePath, latest.state);
                }
                const userLang = detectUserLang(payload.transcriptPath);
                const stagnantSec = Math.max(1, Math.round(stagnantMs / 1000));
                const rawTail = String(snap.tailText || "").trim();
                const tailSnippet = rawTail
                  ? rawTail.slice(-500)
                  : (userLang === "zh" ? "（暂无任何标准输出/错误输出）" : "(No stdout/stderr output yet)");
                const summaryLabel = tracker.toolSummary ? " (" + tracker.toolSummary + ")" : "";
                const zhWakeReason = "【后台终端防卡死巡检提醒】检测到后台终端任务 `" + tid + "`" + summaryLabel + " 的输出日志已连续静默 " + stagnantSec + " 秒无新增字节（可能原因：启动的后台服务/子进程未断开 stdout/stderr 管道句柄导致命令已执行完却一直挂在 running、或正等待交互输入/发生死锁）。\n最新日志尾部快照：\n```\n" + tailSnippet + "\n```\n请立即根据上方日志快照判断：1) 若命令实际已完成目标（如服务已重启并输出健康状态 JSON），请立即调用 `manage_task(Action: \"kill\", TaskId: \"" + tid + "\")` 收割挂起句柄并继续完成回复；2) 若需查看完整状态或发送输入，请调用 `manage_task(Action: \"status\" / \"send_input\", TaskId: \"" + tid + "\")`。";
                const enWakeReason = "[Background Terminal Anti-Hang Watchdog] Background terminal task `" + tid + "`" + summaryLabel + " has produced 0 new log bytes for " + stagnantSec + "s (likely holding stdout/stderr handles open after completion, waiting for interactive prompt, or deadlocked).\nLatest log tail snapshot:\n```\n" + tailSnippet + "\n```\nPlease inspect the snapshot immediately: 1) If the command has already achieved its goal (e.g., server restarted and returned status JSON), call `manage_task(Action: \"kill\", TaskId: \"" + tid + "\")` to reap the hung process handle and finish your response; 2) Otherwise call `manage_task(Action: \"status\" / \"send_input\", TaskId: \"" + tid + "\")`.";
                return reply({
                  decision: "continue",
                  reason: userLang === "zh" ? zhWakeReason : enWakeReason
                });
              }
            }
          }
        }
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

    const convId = extractConvId(payload, payload && (payload.transcriptPath || payload.transcript_path));
    let projectId = String((payload && (payload.projectId || payload.project_id)) || "").trim();

    if (!projectId && convId && fs.existsSync(convDbPath)) {
      try {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(convDbPath, { readOnly: true, open: true });
        const row = db.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?").get(convId);
        db.close();
        if (row && row.project_id) projectId = String(row.project_id).trim();
      } catch (_) {}
    }

    if (!projectId && convId && profiles && profiles.__meta__) {
      const mapped = profiles.__meta__.convProjectMap && profiles.__meta__.convProjectMap[convId];
      if (mapped && profiles[mapped]) projectId = mapped;
    }

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

    if (projectId && profiles && profiles[projectId] && profiles[projectId].plugins && profiles[projectId].plugins["plan-guard"] !== undefined) {
      return Boolean(profiles[projectId].plugins["plan-guard"]);
    }
    if (profiles && profiles.__default__ && profiles.__default__.plugins && profiles.__default__.plugins["plan-guard"] !== undefined) {
      return Boolean(profiles.__default__.plugins["plan-guard"]);
    }
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
  else if (mode === "stop") await handleStop(payload);
  else handlePreToolUse(payload);
}

if (require.main === module) {
  main();
}

module.exports = Object.assign({}, auditMod, grantsMod, stateMod, { detectUserLang, isPlanGuardEnabledForPayload });
