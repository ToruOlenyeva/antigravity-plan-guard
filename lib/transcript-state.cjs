// Antigravity Plan Guard · 增量字节游标状态机 (stateVersion: 2) 与会话级工作区固化调度模块
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  WRITE_FILE_TOOLS,
  EXEC_CMD_TOOLS,
  parseToolArg,
  extractTargetFileFromArgs,
  isUserAuthorized,
  extractAskQuestionPresetOptions,
  evaluateAskQuestionResponse,
  stripArtifactFeedbackFileSync,
  stripArtifactFeedbackButton,
  readTaskLogSnapshot,
  isFastCompletionOrPromptTail
} = require("./read-only-audit.cjs");
const {
  resolveHostHomeDir,
  normalizePathForMatch,
  compactPathPrefixes,
  createEmptyGrants,
  mergeGrants,
  loadKnownProjectCatalog,
  extractConvId,
  extractScopeGrantsFromPlan,
  collectAskQuestionTexts,
  readCurrentConversationPlanArtifact
} = require("./workspace-grants.cjs");

function getStatePath(transcriptPath) {
  if (transcriptPath) {
    try {
      const dir = path.dirname(transcriptPath);
      return path.join(dir, "guard-state.json");
    } catch (e) {}
  }
  return path.join(os.tmpdir(), "antigravity-plan-guard-state.json");
}

function createInitialState() {
  return {
    stateVersion: 2,
    approved: false,
    approvedStepIndex: -1,
    lastScannedOffset: 0,
    hasPlanSinceLastReset: false,
    hasAssistantContentSinceLastReset: false,
    lastAssistantContent: "",
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
    approvedGrants: createEmptyGrants(),
    activeBgTasks: {},
    turnToolCallCount: 0,
    lastPlannerStepHasToolCalls: false,
    lastPlannerStepContentLen: 0,
    foldedToolStepSubstantiveLen: 0,
    foldedToolStepHasFinalReportMarkers: false,
    outerReplyWakeupCount: 0
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

function resolveAndLockWorkspaceRoots(payload, state, statePath, rawTranscriptPath) {
  const homeDir = resolveHostHomeDir();
  const convId = extractConvId(payload, rawTranscriptPath);

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

  if (Array.isArray(state.lockedWorkspaceRoots) && state.lockedWorkspaceRoots.length > 0) {
    return state.lockedWorkspaceRoots;
  }

  const catalog = loadKnownProjectCatalog(homeDir);
  const profilesPath = path.join(homeDir, ".gemini", "config", "project-plugin-profiles.json");
  const convDbPath = path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db");

  let projectId = String(state.lockedProjectId || (payload && (payload.projectId || payload.project_id)) || "").trim();

  if (!projectId && convId && fs.existsSync(convDbPath)) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(convDbPath, { readOnly: true, open: true });
      const row = db.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?").get(convId);
      db.close();
      if (row && row.project_id) projectId = String(row.project_id).trim();
    } catch (_) {}
  }

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
          if (item.id && (item.id.startsWith("plugin:") || item.id.startsWith("sibling:") || item.id.startsWith("plugin-root:"))) continue;
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
  if (dirty && statePath) saveState(statePath, state);
  return state.lockedWorkspaceRoots || [];
}

function backfillLegacyApprovedGrantsIfNeeded(state, statePath, rawTranscriptPath, workspaceRoots, homeDir) {
  if (!state || !state.approved) return;
  if (state.approvedGrants && state.approvedGrants.allowMutatingTools) return;
  const planText = readCurrentConversationPlanArtifact(rawTranscriptPath, true);
  const extracted = extractScopeGrantsFromPlan([planText, state.lastAssistantContent || ""], workspaceRoots, homeDir);
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
    if (firstNl !== -1) offsetInBuf = firstNl + 1;
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

    if (e.status === "CANCELED" || e.status === "CANCELLED") {
      state.approved = false;
      state.approvedStepIndex = -1;
      state.lastResetReason = "canceled";
      state.pendingGrants = createEmptyGrants();
      state.approvedGrants = createEmptyGrants();
      state.activeBgTasks = {};
      state.turnToolCallCount = 0;
      state.lastPlannerStepHasToolCalls = false;
      state.lastPlannerStepContentLen = 0;
      state.foldedToolStepSubstantiveLen = 0;
      state.foldedToolStepHasFinalReportMarkers = false;
      state.outerReplyWakeupCount = 0;
    }

    if (e.source === "USER_EXPLICIT" || e.type === "USER_INPUT") {
      const hadPlan = state.hasPlanSinceLastReset;
      const hadAsk = state.currentAskStepFound || (Array.isArray(state.pendingToolCalls) && state.pendingToolCalls.some((tc) => tc && tc.name === "ask_question"));
      state.pendingToolCalls = [];
      state.pendingStepIndex = -1;
      state.hasPlanSinceLastReset = false;
      state.hasAssistantContentSinceLastReset = false;
      state.currentAskStepFound = false;
      state.currentAskStepHasContent = false;
      state.activeBgTasks = {};
      state.turnToolCallCount = 0;
      state.lastPlannerStepHasToolCalls = false;
      state.lastPlannerStepContentLen = 0;
      state.foldedToolStepSubstantiveLen = 0;
      state.foldedToolStepHasFinalReportMarkers = false;
      state.outerReplyWakeupCount = 0;
      if ((hadPlan || hadAsk) && isUserAuthorized(content)) {
        state.approved = true;
        state.approvedStepIndex = stepIdx;
        state.lastResetReason = "";
        const planArtifactText = readCurrentConversationPlanArtifact(rawTranscriptPath, hadPlan);
        const autoGrants = extractScopeGrantsFromPlan([planArtifactText, state.lastAssistantContent || ""], workspaceRoots, homeDir);
        state.approvedGrants = mergeGrants(state.approvedGrants, mergeGrants(state.pendingGrants, autoGrants));
        state.pendingGrants = createEmptyGrants();
      } else {
        state.approved = false;
        state.approvedStepIndex = -1;
        state.lastResetReason = "user_input";
        state.pendingGrants = createEmptyGrants();
        state.approvedGrants = createEmptyGrants();
        state.lastAssistantContent = "";
      }
      lastValidOffset = readStart + nextOffsetInBuf;
      offsetInBuf = nextOffsetInBuf;
      continue;
    }

    if (e.type === "SYSTEM_MESSAGE" || e.source === "SYSTEM") {
      state.currentAskStepFound = false;
      state.currentAskStepHasContent = false;
      if (/All your subagents and background tasks have been stopped/i.test(content)) {
        state.activeBgTasks = {};
      }
      const finishedTaskMatch = content.match(/Task id "([^"]+)"\s+(?:finished|was killed|terminated|stopped|canceled)/i);
      if (finishedTaskMatch && finishedTaskMatch[1] && state.activeBgTasks) {
        const ftid = finishedTaskMatch[1].trim();
        for (const k of Object.keys(state.activeBgTasks)) {
          if (k === ftid || k.endsWith("/" + ftid) || ftid.endsWith("/" + k)) delete state.activeBgTasks[k];
        }
      }
      const senderTaskMatch = content.match(/sender=([^\s]+\/task-\d+)/i);
      if (senderTaskMatch && senderTaskMatch[1] && /(?:finished with result|Command exited|was killed|terminated|stopped)/i.test(content) && state.activeBgTasks) {
        const stid = senderTaskMatch[1].trim();
        for (const k of Object.keys(state.activeBgTasks)) {
          if (k === stid || k.endsWith("/" + stid) || stid.endsWith("/" + k)) delete state.activeBgTasks[k];
        }
      }
      if (isUserAuthorized(content)) {
        state.approved = true;
        if (stepIdx >= 0) state.approvedStepIndex = stepIdx;
        const planArtifactText = readCurrentConversationPlanArtifact(rawTranscriptPath, true);
        const autoGrants = extractScopeGrantsFromPlan([planArtifactText, state.lastAssistantContent || ""], workspaceRoots, homeDir);
        state.approvedGrants = mergeGrants(state.approvedGrants, mergeGrants(state.pendingGrants, autoGrants));
      }
      lastValidOffset = readStart + nextOffsetInBuf;
      offsetInBuf = nextOffsetInBuf;
      continue;
    }

    if (e.type === "PLANNER_RESPONSE") {
      const visibleText = typeof e.content === "string" ? e.content.trim() : "";
      const isTruncatedContent = Array.isArray(e.truncated_fields) && e.truncated_fields.includes("content");
      const effectiveTextLen = isTruncatedContent ? Math.max(visibleText.length, 2000) : visibleText.length;
      if (visibleText.length > 0) {
        state.hasAssistantContentSinceLastReset = true;
        state.lastAssistantContent = visibleText.slice(0, 16384);
      }
      const hasTools = Array.isArray(e.tool_calls) && e.tool_calls.length > 0;
      if (hasTools) {
        state.pendingToolCalls = e.tool_calls;
        state.pendingStepIndex = stepIdx;
        state.turnToolCallCount = (Number(state.turnToolCallCount) || 0) + e.tool_calls.length;
        state.lastPlannerStepHasToolCalls = true;
        state.lastPlannerStepContentLen = 0;
        for (const tc of e.tool_calls) {
          if (tc && WRITE_FILE_TOOLS.has(tc.name) && tc.args) {
            const tf = extractTargetFileFromArgs(tc.args).replace(/\\/g, "/").toLowerCase();
            if (tf.endsWith("implementation_plan.md")) state.hasPlanSinceLastReset = true;
          }
          if (tc && tc.name === "manage_task" && tc.args) {
            const act = String(parseToolArg(tc.args.Action) || "").toLowerCase();
            const tid = String(parseToolArg(tc.args.TaskId) || "").trim();
            if (act === "kill" && tid && state.activeBgTasks) {
              for (const k of Object.keys(state.activeBgTasks)) {
                if (k === tid || k.endsWith("/" + tid) || tid.endsWith("/" + k)) delete state.activeBgTasks[k];
              }
            }
          }
        }
        const callsAsk = e.tool_calls.some((tc) => tc && tc.name === "ask_question");
        if (callsAsk) {
          state.currentAskStepFound = true;
          state.currentAskStepHasContent = visibleText.length > 0;
          state.approved = false;
          state.approvedStepIndex = -1;
          const askTexts = collectAskQuestionTexts(e.tool_calls, visibleText || state.lastAssistantContent || "");
          const refsPlan = askTexts.some((t) => /implementation_plan\.md/i.test(t));
          const planArtifactText = readCurrentConversationPlanArtifact(rawTranscriptPath, state.hasPlanSinceLastReset || refsPlan);
          if (planArtifactText) askTexts.push(planArtifactText);
          state.pendingGrants = mergeGrants(state.pendingGrants, extractScopeGrantsFromPlan(askTexts, workspaceRoots, homeDir));
        } else if (effectiveTextLen > 0) {
          if (effectiveTextLen > (Number(state.foldedToolStepSubstantiveLen) || 0)) {
            state.foldedToolStepSubstantiveLen = effectiveTextLen;
          }
          if (/(💡|【主动演进建议】|Proactive Evolution|###\s*[一二三四1-4]|已完成全部|实测结果|验证结果)/i.test(visibleText)) {
            state.foldedToolStepHasFinalReportMarkers = true;
          }
        }
      } else {
        state.lastPlannerStepHasToolCalls = false;
        state.lastPlannerStepContentLen = effectiveTextLen;
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

      const bgTaskMatch = content.match(/Tool is running as a background task with task id:\s*([A-Za-z0-9_\/-]+?)(?=\.?\s|$)/i);
      if (bgTaskMatch && bgTaskMatch[1]) {
        const taskId = bgTaskMatch[1].trim();
        let isDaemon = false;
        let toolSummary = "";
        if (Array.isArray(state.pendingToolCalls)) {
          for (const tc of state.pendingToolCalls) {
            if (tc && EXEC_CMD_TOOLS.has(tc.name) && tc.args) {
              if (parseToolArg(tc.args.IsDaemon) === true) isDaemon = true;
              if (tc.args.toolSummary) toolSummary = String(tc.args.toolSummary);
            }
          }
        }
        if (!isDaemon) {
          let logPath = "";
          const logMatch = content.match(/(?:Task logs are available at|Full output is being written to):\s*(?:file:\/\/\/)?([^\r\n]+)/i);
          if (logMatch && logMatch[1]) {
            try { logPath = decodeURIComponent(logMatch[1].trim()); } catch (_) { logPath = logMatch[1].trim(); }
          } else if (rawTranscriptPath) {
            const m = String(rawTranscriptPath).replace(/\\/g, "/").match(/^(.*?\/brain\/[0-9a-f-]{36})\//i);
            const shortTask = taskId.split("/").pop();
            if (m && m[1] && shortTask) {
              logPath = path.join(m[1], ".system_generated", "tasks", shortTask + ".log");
            }
          }
          if (!state.activeBgTasks || typeof state.activeBgTasks !== "object") state.activeBgTasks = {};
          const existing = state.activeBgTasks[taskId];
          state.activeBgTasks[taskId] = {
            taskId,
            logPath: logPath || (existing && existing.logPath) || "",
            toolSummary: toolSummary || (existing && existing.toolSummary) || "",
            wakeupCount: existing && typeof existing.wakeupCount === "number" ? existing.wakeupCount : 0
          };
        }
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
                const fullAskTexts = collectAskQuestionTexts(fe.tool_calls, fe.content || state.lastAssistantContent || "");
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
        state.turnToolCallCount = 0;
        state.lastPlannerStepHasToolCalls = false;
        state.lastPlannerStepContentLen = 0;
        state.foldedToolStepSubstantiveLen = 0;
        state.foldedToolStepHasFinalReportMarkers = false;
        state.outerReplyWakeupCount = 0;
        if (askEval.approved) {
          state.approved = true;
          state.approvedStepIndex = stepIdx;
          state.lastResetReason = "";
          const planArtifactText = readCurrentConversationPlanArtifact(rawTranscriptPath, hadPlan);
          const fallbackGrants = extractScopeGrantsFromPlan([planArtifactText, state.lastAssistantContent || ""], workspaceRoots, homeDir);
          state.approvedGrants = mergeGrants(state.approvedGrants, mergeGrants(state.pendingGrants, fallbackGrants));
          state.pendingGrants = createEmptyGrants();
        } else {
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

module.exports = {
  getStatePath,
  createInitialState,
  loadState,
  saveState,
  isUserAuthorized,
  extractAskQuestionPresetOptions,
  evaluateAskQuestionResponse,
  resolveAndLockWorkspaceRoots,
  syncTranscriptState,
  stripArtifactFeedbackFileSync,
  stripArtifactFeedbackButton,
  readTaskLogSnapshot,
  isFastCompletionOrPromptTail
};
