[English](README.en.md) | [简体中文](README.md)

<div align="center">
  <img src="assets/logo.svg" alt="Plan Guard Logo" width="72" height="72" />
  <h1>Antigravity Plan Guard</h1>
  <p>
    <b>Plan-First Zero-Trust Gatekeeper Plugin for Google Antigravity 2.0</b><br>
    Intercepts unauthorized file writes and side-effect commands, compelling the primary agent to conduct plan reviews via <code>ask_question</code>.
  </p>
  <p>
    <a href="https://antigravity.google/"><img src="https://img.shields.io/badge/Google%20Antigravity%202.0-Plugin-4285F4?style=flat-square&logo=google&logoColor=white" alt="Google Antigravity 2.0 Plugin" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D%2018-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
    <a href="docs/ARCHITECTURE.en.md"><img src="https://img.shields.io/badge/Dependencies-Zero-brightgreen?style=flat-square" alt="Zero Dependencies" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-orange?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/ToruOlenyeva/antigravity-plan-guard/stargazers"><img src="https://img.shields.io/github/stars/ToruOlenyeva/antigravity-plan-guard?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  </p>
</div>

> <b>Stop unauthorized code mutations and duplicate confirmation prompts</b>: Purpose-built for <b>Google Antigravity 2.0</b> (the parallel multi-agent desktop client). Solves the critical issue where LLMs overwrite source files without approval or trigger duplicate native `Proceed` and `ask_question` prompts when writing `implementation_plan.md` artifacts, enforcing a deterministic zero-trust state machine at the `PreToolUse` / `PostToolUse` hook layer.

<div align="center">
  <img src="assets/preview-en.png" width="840" alt="Antigravity Plan Guard Preview" />
</div>

---

## ✨ Key Features

- <b>Full-Disk Read Freedom & Conversation-Isolated Workspace Locking</b>: Designed to pair seamlessly with Antigravity's native security presets (<b>Turbo / Auto</b> + <b>Allow Non-Workspace File Access</b>). During research, all read-only tools (`read_file`, `grep_search`, read-only terminal commands, `research` subagents) are allowed across the entire disk with zero popups; meanwhile, each conversation independently resolves and locks its own project workspace (`lockedWorkspaceRoots`) by `convId`, remaining 100% immune to foreground project switching.
- <b>Implicit Scoped Permission Requests & Out-of-Workspace Boundary Control</b>: When proposing a plan in `ask_question`, the primary agent simply explains what will be modified (and which out-of-workspace project/directory is involved, without needing to list specific tool names or deep leaf file paths). In the background, Plan Guard automatically applies for mutation tool permissions and coarse-grained external path prefixes; once approved, declared targets are allowed while any undeclared out-of-workspace file writes or mutating commands are strictly blocked (`deny`).
- <b>Same-Turn Explanation Enforcement</b>: Compels the primary agent to output a complete root-cause and architectural explanation in the chat body within the exact same turn as calling the `ask_question` modal.
- <b>Buttonless Clean `Implementation Plan` Card Guard</b>: Bypasses the Go `proto3` zero-value omission quirk in `language_server.exe` by physically rewriting `"requestFeedback": false` in `.metadata.json` across `PreToolUse`, `PostToolUse`, and asynchronous post-write watchers, stripping the redundant blue `Proceed` (`Ctrl+Enter`) button while preserving the clean clickable plan card.
- <b>Subagent Passthrough & Scope Inheritance</b>: Automatically identifies delegated subagents via `transcript.jsonl` lineage inspection and inherits the parent conversation's locked workspace and approved external path prefixes, granting friction-free execution within the approved scope.
- <b>Zero-Token Background Terminal Anti-Hang Watchdog</b>: When the agent launches a non-daemon background command and yields its turn awaiting completion (`NO_TOOL_CALL && fullyIdle === false`), the `Stop` hook monitors `.system_generated/tasks/task-XXXX.log` locally at zero token cost. As long as log bytes continue growing, the timer resets without interrupting long builds; once the log tail stagnates (e.g., a restarted background server holding `stdout/stderr` pipes open or an interactive prompt hang), Plan Guard returns `{"decision": "continue"}` with the latest log tail snapshot to wake the agent so it can reap the hung task via `manage_task(Action: "kill")`.
- <b>Auto Language Detection for Chinese & English Users</b>: Automatically detects user dialog language (via latest user message in `transcript.jsonl` or system locale fallback) to deliver localized prompt instructions and action buttons (Chinese: "`确认执行 / 暂不修改`" vs English: "`Confirm & Execute / Cancel`").
- <b>Zero External Dependencies</b>: Single-file vanilla Node.js implementation (`guard.cjs`) with zero npm dependencies and sub-millisecond evaluation latency.

---

## 🔄 Core Workflow

```mermaid
flowchart TD
    A["Agent Triggers Tool Call (PreToolUse)"] --> B{"Is Tool Read-Only / Inspection Command?"}
    B -- "Yes (Full-Disk Read)" --> C["Allow Silently Across Entire Disk (allow)"]
    B -- "Write implementation_plan.md Artifact" --> D["Enforce requestFeedback: false & Allow"]
    B -- "Call ask_question to Propose Plan" --> E["Audit Chat Body + Auto-Extract Tool & External Path Grants"]
    B -- "Write Business File / Mutating Command" --> F{"Is Approved or Delegated Subagent?"}
    F -- "No (Unauthorized Mutation)" --> G["Intercept & Block (deny), Prompt ask_question"]
    F -- "Yes (Approved / Subagent)" --> H{"Is Target Inside Locked Workspace or Approved External Prefix?"}
    H -- "Yes (Within Approved Scope)" --> I["Allow Execution (allow)"]
    H -- "No (Undeclared Out-of-Workspace Path)" --> J["Block Out-of-Bounds Mutation (deny) & Require Scope Application"]
```

---

## 🚀 Quick Installation

Built with native Node.js and <b>Zero Dependencies</b>. Clone and run immediately without executing <code>npm install</code>.

### 1. Clone into Antigravity Plugins Directory

<b>macOS / Linux</b>:
```bash
git clone https://github.com/ToruOlenyeva/antigravity-plan-guard.git ~/.gemini/config/plugins/plan-guard
```

<b>Windows (PowerShell)</b>:
```powershell
git clone https://github.com/ToruOlenyeva/antigravity-plan-guard.git "$env:USERPROFILE\.gemini\config\plugins\plan-guard"
```

<b>Windows (CMD)</b>:
```cmd
git clone https://github.com/ToruOlenyeva/antigravity-plan-guard.git %USERPROFILE%\.gemini\config\plugins\plan-guard
```

### 2. Enable and Launch

Restart Google Antigravity or toggle the plugin directly in `plugin-switcher` after cloning.

---

## 📖 Usage Guide

### 1. Read-Only Research & Code Inspection
When the agent executes `read_file`, searches codebases, or runs read-only terminal verification commands (such as `git status`, `tsc --noEmit`, or `cargo check`), Plan Guard allows execution silently with zero friction.

### 2. Code Refactoring & Multi-Option Plan Approval
When the agent intends to modify source files or execute mutating commands:
- The primary agent explains the root cause and design rationale in the chat response while rendering an `ask_question` confirmation modal.
- Select the recommended confirmation button for single-plan execution, or pick between `Option A` and `Option B` when multiple architectural trade-offs are presented.
- Submitting custom Write-In feedback automatically resets the approval state, ensuring the agent revises its plan and re-confirms before touching disk.

### 3. Autonomous Subagent Orchestration
Once you approve a plan on the primary agent and it delegates batch implementation via `invoke_subagent`, child subagents automatically bypass interactive prompts to execute concurrent file writes and test suites at full speed.

---

## 📚 Documentation Matrix

| Module | Description & Technical Details | Link |
| :--- | :--- | :--- |
| <b>System Architecture</b> | Three-phase gate model, state machine transitions, native `Proceed` button mechanics, and JSON contracts | [View Architecture](docs/ARCHITECTURE.en.md) |
| <b>Example Hook Configuration</b> | Standard `PreToolUse` and `PostToolUse` lifecycle hook registration template | [View Example Config](hooks.example.json) |

---

## 🤝 Contributors & Credits

- <b>[Toru Olenyeva](https://github.com/ToruOlenyeva)</b>
- <b>[Google Antigravity](https://antigravity.google/)</b>

---

## 📄 License

This project is licensed under the [<b>MIT License</b>](LICENSE).
