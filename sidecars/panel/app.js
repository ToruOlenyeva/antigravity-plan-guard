// Antigravity Plan Guard Sidecar Panel Controller
let savedLang = null;
try { savedLang = localStorage.getItem("plan_guard_lang"); } catch (e) {}
const defaultBrowserLang = (typeof navigator !== "undefined" && typeof navigator.language === "string" && /^zh\b/i.test(navigator.language)) ? "zh" : "en";
let currentLang = (savedLang === "en" || savedLang === "zh") ? savedLang : defaultBrowserLang;

let policyState = {
  version: 1,
  mode: "whitelist",
  includeBuiltinReadOnly: true,
  whitelist: [],
  blacklist: [],
  updatedAt: 0
};
let builtinExamples = [];
let currentVersionToken = "";
let filterQuery = "";
let editingRuleId = "";
let isBatchOpen = false;
let resetConfirmTimer = null;
let toastTimer = null;
let testDebounceTimer = null;
let isViewportIntersecting = true;

const isPluginCustomScheme = typeof window !== "undefined" && window.location?.protocol === "plugin:";
const isEmbeddedSidecar = typeof window !== "undefined" && window.location?.port !== "8090" && Boolean(
  isPluginCustomScheme ||
  window.sidecar ||
  new URLSearchParams(window.location?.search || "").get("token")
);

function detectSwitchSupportAndApplyFallback() {
  const supportsSwitch = typeof HTMLInputElement !== "undefined" && "switch" in HTMLInputElement.prototype;
  if (!supportsSwitch) {
    document.querySelectorAll('input[type="checkbox"][switch]').forEach((el) => {
      el.classList.add("fallback-switch");
    });
  }
}

function isPanelActuallyVisible() {
  if (!isEmbeddedSidecar) return true;
  if (document.hidden) return false;
  if (!isViewportIntersecting) return false;
  if (window.innerWidth <= 10 || window.innerHeight <= 10) return false;
  if (!document.body || document.body.offsetWidth <= 10 || document.body.offsetHeight <= 10) return false;
  return true;
}

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.display = "none";
  }, 2600);
}

window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "theme-change") {
    const vars = event.data.payload?.cssVariables || {};
    const bg = (vars["--background"] || vars["--bg-base"] || vars["--vscode-editor-background"] || "").trim().toLowerCase();
    if (bg) {
      const isLight = bg.startsWith("#f") || bg.startsWith("#e") || bg.startsWith("#d") || bg === "white" || bg.startsWith("rgb(25") || bg.startsWith("rgb(24");
      const mode = isLight ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", mode);
      try { localStorage.setItem("antigravity_theme_mode", mode); } catch (e) {}
    }
  }
});

if (typeof window !== "undefined" && window.matchMedia) {
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
      const mode = e.matches ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", mode);
    });
  } catch (e) {}
}

function getActiveListKey() {
  return policyState.mode === "blacklist" ? "blacklist" : "whitelist";
}

function detectRuleKind(pattern, t) {
  const p = String(pattern || "").trim();
  if (p.startsWith("/") && /^\/.+\/[gimsuy]*$/.test(p)) return t.kindRegex;
  if (p.includes("*")) return t.kindGlob;
  return t.kindPrefix;
}

function resetConfirmButtonState() {
  const btn = document.getElementById("btnResetDefaults");
  if (!btn) return;
  btn.classList.remove("confirming");
  btn.textContent = I18N[currentLang].btnResetDefaults;
  clearTimeout(resetConfirmTimer);
  resetConfirmTimer = null;
}

function applyI18n() {
  const t = I18N[currentLang];
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";
  document.getElementById("uiAppTitle").textContent = t.appTitle;
  document.getElementById("langToggleBtn").textContent = t.langBtn;
  document.getElementById("refreshBtn").textContent = t.refreshBtn;
  document.getElementById("secModeLegend").textContent = t.secModeLegend;
  document.getElementById("modeLabelWhitelist").textContent = t.modeLabelWhitelist;
  document.getElementById("modeLabelBlacklist").textContent = t.modeLabelBlacklist;
  document.getElementById("builtinToggleLabel").textContent = t.builtinToggleLabel;
  document.getElementById("builtinToggleHint").textContent = t.builtinToggleHint;
  document.getElementById("btnAddRule").textContent = t.btnAddRule;
  document.getElementById("batchRuleLabel").textContent = t.batchRuleLabel;
  document.getElementById("btnCancelBatch").textContent = t.btnCancelBatch;
  document.getElementById("btnConfirmBatch").textContent = t.btnConfirmBatch;
  document.getElementById("syntaxHintText").textContent = t.syntaxHintText;
  document.getElementById("ruleSearchInput").placeholder = t.ruleSearchPlaceholder;
  document.getElementById("secTesterTitle").textContent = t.secTesterTitle;
  document.getElementById("cmdTesterInput").placeholder = t.cmdTesterPlaceholder;
  document.getElementById("btnRunTest").textContent = t.btnRunTest;
  resetConfirmButtonState();
  renderAll();
}

function renderAll() {
  const t = I18N[currentLang];
  const isBlacklist = policyState.mode === "blacklist";

  const modeBadge = document.getElementById("uiModeBadge");
  modeBadge.textContent = isBlacklist ? t.modeBlacklistBadge : t.modeWhitelistBadge;
  modeBadge.classList.toggle("mode-blacklist", isBlacklist);

  document.getElementById("modeRadioWhitelist").checked = !isBlacklist;
  document.getElementById("modeRadioBlacklist").checked = isBlacklist;
  document.getElementById("modeDescBanner").textContent = isBlacklist ? t.modeDescBlacklist : t.modeDescWhitelist;

  const builtinRow = document.getElementById("builtinReadonlyRow");
  builtinRow.hidden = isBlacklist;
  const builtinToggle = document.getElementById("builtinReadonlyToggle");
  builtinToggle.checked = policyState.includeBuiltinReadOnly !== false;
  if (builtinExamples.length > 0) {
    document.getElementById("builtinToggleHint").title = builtinExamples.join("\n");
  }

  document.getElementById("secRulesTitle").textContent = isBlacklist ? t.secRulesTitleBlacklist : t.secRulesTitleWhitelist;
  document.getElementById("newRuleInput").placeholder = isBlacklist ? t.newRulePlaceholderBl : t.newRulePlaceholderWl;

  const batchBtn = document.getElementById("btnToggleBatch");
  batchBtn.textContent = isBatchOpen ? t.btnHideBatch : t.btnToggleBatch;
  batchBtn.setAttribute("aria-expanded", String(isBatchOpen));
  document.getElementById("batchAddDrawer").hidden = !isBatchOpen;

  renderRuleList();
  detectSwitchSupportAndApplyFallback();
}

function renderRuleList() {
  const t = I18N[currentLang];
  const listEl = document.getElementById("ruleList");
  const countPill = document.getElementById("rulesCountPill");
  if (!listEl || !countPill) return;

  const listKey = getActiveListKey();
  const fullList = Array.isArray(policyState[listKey]) ? policyState[listKey] : [];
  countPill.textContent = String(fullList.length);

  const q = filterQuery.trim().toLowerCase();
  const visibleList = q
    ? fullList.filter((item) => String(item.pattern || "").toLowerCase().includes(q))
    : fullList;

  const clearBtn = document.getElementById("ruleSearchClearBtn");
  if (clearBtn) clearBtn.hidden = !filterQuery;

  listEl.innerHTML = "";
  if (visibleList.length === 0) {
    const emptyLi = document.createElement("li");
    emptyLi.className = "rule-empty";
    if (fullList.length > 0 && q) {
      emptyLi.textContent = t.emptyFiltered;
    } else {
      emptyLi.textContent = listKey === "blacklist" ? t.emptyBlacklist : t.emptyWhitelist;
    }
    listEl.appendChild(emptyLi);
    return;
  }

  for (const item of visibleList) {
    const li = document.createElement("li");
    li.className = "rule-item" + (item.enabled === false ? " disabled" : "");

    const left = document.createElement("div");
    left.className = "rule-left";

    const sw = document.createElement("input");
    sw.type = "checkbox";
    sw.setAttribute("switch", "");
    sw.className = "native-switch small";
    sw.checked = item.enabled !== false;
    sw.title = item.pattern;
    sw.addEventListener("change", () => {
      toggleRuleEnabled(item.id, sw.checked);
    });
    left.appendChild(sw);

    const kindTag = document.createElement("span");
    kindTag.className = "rule-kind-tag";
    kindTag.textContent = detectRuleKind(item.pattern, t);
    left.appendChild(kindTag);

    if (editingRuleId === item.id) {
      const editInput = document.createElement("input");
      editInput.type = "text";
      editInput.className = "rule-edit-input mono";
      editInput.value = item.pattern;
      editInput.setAttribute("autocomplete", "off");
      editInput.setAttribute("autocorrect", "off");
      editInput.setAttribute("autocapitalize", "none");
      editInput.setAttribute("spellcheck", "false");
      editInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          if (ev.isComposing || ev.keyCode === 229) return;
          commitRuleEdit(item.id, editInput.value);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          editingRuleId = "";
          renderRuleList();
        }
      });
      left.appendChild(editInput);

      const actions = document.createElement("div");
      actions.className = "rule-actions";

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "icon-btn";
      saveBtn.textContent = t.btnSaveEdit;
      saveBtn.addEventListener("click", () => commitRuleEdit(item.id, editInput.value));

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "icon-btn";
      cancelBtn.textContent = t.btnCancelEdit;
      cancelBtn.addEventListener("click", () => {
        editingRuleId = "";
        renderRuleList();
      });

      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);
      li.appendChild(left);
      li.appendChild(actions);
      listEl.appendChild(li);
      setTimeout(() => editInput.focus(), 0);
      continue;
    }

    const patSpan = document.createElement("span");
    patSpan.className = "rule-pattern mono";
    patSpan.textContent = item.pattern;
    patSpan.title = item.pattern;
    left.appendChild(patSpan);

    const actions = document.createElement("div");
    actions.className = "rule-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "icon-btn";
    editBtn.textContent = t.btnEdit;
    editBtn.addEventListener("click", () => {
      editingRuleId = item.id;
      renderRuleList();
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-btn del";
    delBtn.textContent = t.btnDelete;
    delBtn.addEventListener("click", () => deleteRuleById(item.id));

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(left);
    li.appendChild(actions);
    listEl.appendChild(li);
  }
  detectSwitchSupportAndApplyFallback();
}

async function savePolicyConfig(nextConfig, successToast = "") {
  const prevBackup = JSON.parse(JSON.stringify(policyState));
  policyState = nextConfig;
  renderAll();
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextConfig)
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || "Save failed");
    policyState = data.config;
    if (data.version) currentVersionToken = data.version;
    renderAll();
    if (successToast) showToast(successToast);
    scheduleCommandTesterRun();
  } catch (err) {
    policyState = prevBackup;
    renderAll();
    showToast(`${I18N[currentLang].toastSaveError}${err.message || err}`);
  }
}

function addSingleRule(rawPattern) {
  const t = I18N[currentLang];
  const pattern = String(rawPattern || "").trim();
  if (!pattern) return false;

  const listKey = getActiveListKey();
  const curList = Array.isArray(policyState[listKey]) ? policyState[listKey] : [];
  if (curList.some((r) => String(r.pattern || "").trim().toLowerCase() === pattern.toLowerCase())) {
    showToast(t.toastDuplicate);
    return false;
  }

  const nextList = [
    ...curList,
    { id: `${listKey === "blacklist" ? "bl" : "wl"}-${Date.now()}`, pattern, enabled: true }
  ];
  const next = { ...policyState, [listKey]: nextList };
  savePolicyConfig(next, `${t.toastAdded}${pattern}`);
  return true;
}

function importBatchRules(rawText) {
  const t = I18N[currentLang];
  const lines = String(rawText || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return;

  const listKey = getActiveListKey();
  const curList = Array.isArray(policyState[listKey]) ? policyState[listKey] : [];
  const seen = new Set(curList.map((r) => String(r.pattern || "").trim().toLowerCase()));
  const appended = [];

  for (const line of lines) {
    const k = line.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    appended.push({
      id: `${listKey === "blacklist" ? "bl" : "wl"}-${Date.now()}-${appended.length + 1}`,
      pattern: line,
      enabled: true
    });
  }

  isBatchOpen = false;
  document.getElementById("batchRuleTextarea").value = "";
  if (appended.length === 0) {
    renderAll();
    showToast(t.toastDuplicate);
    return;
  }
  const next = { ...policyState, [listKey]: [...curList, ...appended] };
  savePolicyConfig(next, `${t.toastBatchAddedPrefix}${appended.length}`);
}

function toggleRuleEnabled(id, enabled) {
  const listKey = getActiveListKey();
  const curList = Array.isArray(policyState[listKey]) ? policyState[listKey] : [];
  const nextList = curList.map((r) => (r.id === id ? { ...r, enabled: Boolean(enabled) } : r));
  savePolicyConfig({ ...policyState, [listKey]: nextList }, I18N[currentLang].toastSaved);
}

function commitRuleEdit(id, rawValue) {
  const pattern = String(rawValue || "").trim();
  editingRuleId = "";
  if (!pattern) {
    renderRuleList();
    return;
  }
  const listKey = getActiveListKey();
  const curList = Array.isArray(policyState[listKey]) ? policyState[listKey] : [];
  const dup = curList.some((r) => r.id !== id && String(r.pattern || "").trim().toLowerCase() === pattern.toLowerCase());
  if (dup) {
    renderRuleList();
    showToast(I18N[currentLang].toastDuplicate);
    return;
  }
  const nextList = curList.map((r) => (r.id === id ? { ...r, pattern } : r));
  savePolicyConfig({ ...policyState, [listKey]: nextList }, I18N[currentLang].toastSaved);
}

function deleteRuleById(id) {
  const listKey = getActiveListKey();
  const curList = Array.isArray(policyState[listKey]) ? policyState[listKey] : [];
  const nextList = curList.filter((r) => r.id !== id);
  savePolicyConfig({ ...policyState, [listKey]: nextList }, I18N[currentLang].toastSaved);
}

async function handleResetDefaultsClick() {
  const btn = document.getElementById("btnResetDefaults");
  const t = I18N[currentLang];
  if (!btn.classList.contains("confirming")) {
    btn.classList.add("confirming");
    btn.textContent = t.btnConfirmReset;
    clearTimeout(resetConfirmTimer);
    resetConfirmTimer = setTimeout(() => resetConfirmButtonState(), 3500);
    return;
  }
  resetConfirmButtonState();
  try {
    const scope = getActiveListKey();
    const res = await fetch("/api/reset-defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      policyState = data.config;
      if (data.version) currentVersionToken = data.version;
      renderAll();
      scheduleCommandTesterRun();
      showToast(t.toastResetDone);
    }
  } catch {}
}

function formatTestReason(result, t) {
  if (!result) return "";
  if (result.reason === "matched_whitelist") return `${t.reasonMatchedWhitelist}${result.matchedRule || ""}`;
  if (result.reason === "builtin_readonly") return t.reasonBuiltinReadOnly;
  if (result.reason === "not_in_whitelist") return t.reasonNotInWhitelist;
  if (result.reason === "matched_blacklist") return `${t.reasonMatchedBlacklist}${result.matchedRule || ""}`;
  if (result.reason === "not_in_blacklist") return t.reasonNotInBlacklist;
  if (result.reason === "command_substitution") return t.reasonCmdSub;
  return t.reasonEmpty;
}

async function runCommandTester() {
  const inputEl = document.getElementById("cmdTesterInput");
  const resultBox = document.getElementById("cmdTesterResult");
  if (!inputEl || !resultBox) return;
  const cmd = String(inputEl.value || "").trim();
  if (!cmd) {
    resultBox.hidden = true;
    resultBox.innerHTML = "";
    return;
  }
  try {
    const res = await fetch("/api/test-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: cmd, config: policyState })
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.result) return;
    const result = data.result;
    const t = I18N[currentLang];
    const isAllow = result.decision === "allow";

    resultBox.className = `tester-result ${isAllow ? "allow" : "gate"}`;
    resultBox.hidden = false;
    resultBox.innerHTML = "";

    const summaryRow = document.createElement("div");
    summaryRow.className = "tester-summary-row";

    const verdictEl = document.createElement("span");
    verdictEl.className = "tester-verdict";
    verdictEl.textContent = isAllow ? `✓ ${t.testerAllow}` : `✕ ${t.testerGate}`;

    const reasonEl = document.createElement("span");
    reasonEl.className = "tester-reason";
    reasonEl.textContent = formatTestReason(result, t);

    summaryRow.appendChild(verdictEl);
    summaryRow.appendChild(reasonEl);
    resultBox.appendChild(summaryRow);

    if (Array.isArray(result.segments) && result.segments.length > 0) {
      const segWrap = document.createElement("div");
      segWrap.className = "tester-segments";
      for (const seg of result.segments) {
        const chip = document.createElement("span");
        chip.className = `tester-seg-chip mono ${seg.decision === "allow" ? "allow" : "gate"}`;
        const tag = seg.decision === "allow" ? "✓" : "✕";
        chip.textContent = `${tag} ${seg.text}`;
        if (seg.matchedRule) chip.title = seg.matchedRule;
        segWrap.appendChild(chip);
      }
      resultBox.appendChild(segWrap);
    }
  } catch {}
}

function scheduleCommandTesterRun() {
  clearTimeout(testDebounceTimer);
  const inputEl = document.getElementById("cmdTesterInput");
  if (!inputEl || !inputEl.value.trim()) {
    const resultBox = document.getElementById("cmdTesterResult");
    if (resultBox) {
      resultBox.hidden = true;
      resultBox.innerHTML = "";
    }
    return;
  }
  testDebounceTimer = setTimeout(() => runCommandTester(), 150);
}

async function loadConfigFromServer(showNotice = false) {
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    const data = await res.json();
    if (data && data.success && data.config) {
      policyState = data.config;
      if (data.version) currentVersionToken = data.version;
      if (Array.isArray(data.builtinReadOnlyExamples)) builtinExamples = data.builtinReadOnlyExamples;
      renderAll();
      scheduleCommandTesterRun();
      if (showNotice) showToast(I18N[currentLang].toastRefreshed);
    }
  } catch {}
}

let activeEventSource = null;
let fallbackPollTimer = null;

function disconnectRealtimeSync() {
  if (activeEventSource) {
    try { activeEventSource.close(); } catch {}
    activeEventSource = null;
  }
  if (fallbackPollTimer) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }
}

function setupRealtimeSync() {
  disconnectRealtimeSync();
  if (!isPanelActuallyVisible()) return;

  if (!isPluginCustomScheme && typeof EventSource !== "undefined") {
    try {
      const es = new EventSource("/api/events");
      activeEventSource = es;
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data || "{}");
          if (data && data.config) {
            if (data.version && data.version === currentVersionToken) return;
            policyState = data.config;
            if (data.version) currentVersionToken = data.version;
            if (Array.isArray(data.builtinReadOnlyExamples)) builtinExamples = data.builtinReadOnlyExamples;
            renderAll();
            scheduleCommandTesterRun();
          }
        } catch {}
      };
      return;
    } catch {}
  }

  // plugin:// 内嵌态严禁开启 EventSource，改用可见态轻量版本轮询
  fallbackPollTimer = setInterval(async () => {
    if (!isPanelActuallyVisible()) return;
    try {
      const res = await fetch("/api/state-version", { cache: "no-store" });
      const data = await res.json();
      if (data && data.version && data.version !== currentVersionToken) {
        await loadConfigFromServer(false);
      }
    } catch {}
  }, 3000);
}

function bindEvents() {
  document.getElementById("langToggleBtn").addEventListener("click", () => {
    currentLang = currentLang === "zh" ? "en" : "zh";
    try { localStorage.setItem("plan_guard_lang", currentLang); } catch (e) {}
    applyI18n();
    fetch("/api/set-language", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: currentLang })
    }).catch(() => {});
  });

  document.getElementById("refreshBtn").addEventListener("click", () => {
    loadConfigFromServer(true);
  });

  document.getElementById("modeRadioWhitelist").addEventListener("change", (ev) => {
    if (!ev.target.checked) return;
    editingRuleId = "";
    resetConfirmButtonState();
    savePolicyConfig({ ...policyState, mode: "whitelist" }, I18N[currentLang].toastSaved);
  });

  document.getElementById("modeRadioBlacklist").addEventListener("change", (ev) => {
    if (!ev.target.checked) return;
    editingRuleId = "";
    resetConfirmButtonState();
    savePolicyConfig({ ...policyState, mode: "blacklist" }, I18N[currentLang].toastSaved);
  });

  document.getElementById("builtinReadonlyToggle").addEventListener("change", (ev) => {
    savePolicyConfig({ ...policyState, includeBuiltinReadOnly: Boolean(ev.target.checked) }, I18N[currentLang].toastSaved);
  });

  document.getElementById("btnToggleBatch").addEventListener("click", () => {
    isBatchOpen = !isBatchOpen;
    renderAll();
    if (isBatchOpen) document.getElementById("batchRuleTextarea").focus();
  });

  document.getElementById("btnCancelBatch").addEventListener("click", () => {
    isBatchOpen = false;
    renderAll();
  });

  document.getElementById("btnResetDefaults").addEventListener("click", handleResetDefaultsClick);

  document.getElementById("addRuleForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = document.getElementById("newRuleInput");
    if (addSingleRule(input.value)) {
      input.value = "";
    }
  });

  document.getElementById("batchAddDrawer").addEventListener("submit", (ev) => {
    ev.preventDefault();
    importBatchRules(document.getElementById("batchRuleTextarea").value);
  });

  document.getElementById("ruleSearchInput").addEventListener("input", (ev) => {
    filterQuery = ev.target.value || "";
    renderRuleList();
  });

  document.getElementById("ruleSearchClearBtn").addEventListener("click", () => {
    filterQuery = "";
    document.getElementById("ruleSearchInput").value = "";
    renderRuleList();
  });

  document.getElementById("cmdTesterForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    runCommandTester();
  });

  document.getElementById("cmdTesterInput").addEventListener("input", scheduleCommandTesterRun);

  document.addEventListener("visibilitychange", () => {
    if (isPanelActuallyVisible()) {
      loadConfigFromServer(false);
      setupRealtimeSync();
    } else {
      disconnectRealtimeSync();
    }
  });
  window.addEventListener("pagehide", disconnectRealtimeSync);
  window.addEventListener("beforeunload", disconnectRealtimeSync);

  if (typeof IntersectionObserver !== "undefined") {
    const obs = new IntersectionObserver((entries) => {
      isViewportIntersecting = entries.some((e) => e.isIntersecting);
      if (isPanelActuallyVisible()) setupRealtimeSync();
      else disconnectRealtimeSync();
    });
    obs.observe(document.body);
  }
}

bindEvents();
applyI18n();
loadConfigFromServer(false).then(setupRealtimeSync);
