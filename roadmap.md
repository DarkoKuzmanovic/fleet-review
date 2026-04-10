# Roadmap: v0.3 to v0.4

## Audit Triage: Verified vs. Hallucinated

Based on Qwen Code's audit (2026-04-10), verified against actual codebase.

### Confirmed Real (15 findings)

| # | Finding | Location | Notes |
|---|---------|----------|-------|
| 1 | ScoreStore data loss on corrupted JSON | `ScoreStore.ts:72-73` | Non-ENOENT errors silently return `[]`, discarding all cached data |
| 2 | `-pid` kill fails on Windows | `CliDispatcher.ts:247` | `process.kill(-pid)` is Unix-only |
| 3 | Triple backticks in diff break prompt | `PromptBuilder.ts:65-67` | Plain ` ``` ` fence with unescaped diff content |
| 4 | `JSON.parse` without try/catch in GitHubClient | `GitHubClient.ts:48,85,155` | Bare `JSON.parse` on `gh` stdout |
| 6 | GitHub comment posting silently fails | `ReviewOrchestrator.ts:97-99` | Bare `catch {}`, user never learns posting failed |
| 7 | `runMerge` hardcodes `claude` | `ReviewOrchestrator.ts:174` | `dispatch('claude', ...)` with no fallback |
| 8 | Fragile timeout detection via string matching | `CliDispatcher.ts:208` | `err.message.includes('abort')` in `httpDispatch` only |
| 9 | Synchronous file writes block event loop | `ScoreStore.ts:55,97,104,184` | `writeFileSync` on main thread |
| 10 | `pendingTimeouts` Map leak on crash | `SidebarProvider.ts:19` | Entries stay if review crashes before resolution |
| 13 | Zero tests | Entire project | No `*.test.ts` files exist |
| 14 | ~1600-line `getHtml()` | `SidebarProvider.ts` | 1606 lines total |
| 15 | Dead types | `types.ts:9,82-89` | `ReviewStatus` and `PendingScores` unused |
| 17 | Duplicate `stderr` listeners | `CliDispatcher.ts:289,357` | Two separate `proc.stderr.on('data')` handlers |
| 18 | `ReviewPanel` degraded features | `ReviewPanel.ts` | No retry, streaming, progress, or timeout support |
| (detail) | Duplicate `escapeHtml` | `GradingPanel.ts:221` + `webviewUtils.ts` | Module-level and inline webview copies |

### Hallucinated or Wrong (3 findings)

| # | Claim | Verdict |
|---|-------|---------|
| 12 | "Pending scores deleted before import event fires" | **Wrong.** Code saves first, deletes second. Already safe. |
| 5 | "`.includes()` throws if overrides is not an array" | **Overstated.** VS Code config API with default array + schema enforcement makes this near-impossible. |
| (detail) | "modelTimeouts reads config in a loop per model" | **Misleading.** VS Code config API caches in memory, no IPC per iteration. |

### Not Implementable / Won't Fix

| # | Finding | Why |
|---|---------|-----|
| 2 | Windows process group kill | Target audience uses Unix CLIs. No demand yet. |
| 11 | CSP `unsafe-inline` | Unavoidable without extracting webview JS to files (large refactor, deferred to v0.4). |
| 16 | `onStartupFinished` activation | `fs.watch` for auto-import needs early start. Marginal benefit to change. |

---

## Release Plan

### v0.3.1 — Data Safety

Prevent silent data loss. Smallest diff, highest impact.

- [ ] Re-throw non-ENOENT errors in `loadReviews()` / `loadScores()` instead of returning `[]` (`ScoreStore.ts`, finding #1)
- [ ] Wrap `JSON.parse` calls in `listPRs`, `getPRInfo`, `getAuditComments` with try/catch (`GitHubClient.ts`, finding #4)
- [ ] Use `````diff` (4+ backtick) fences to prevent diff content breaking prompt structure (`PromptBuilder.ts`, finding #3)

### v0.3.2 — User Feedback on Failures

Surface errors that are currently swallowed silently.

- [ ] Surface `postedToGitHub: false` as a warning notification when comment posting fails (`ReviewOrchestrator.ts`, finding #6)
- [ ] Use `Config.defaultModels[0]` for merge synthesis instead of hardcoded `'claude'` (`ReviewOrchestrator.ts`, finding #7)
- [ ] Check `signal.aborted` or `err.name === 'AbortError'` in `httpDispatch` instead of `err.message.includes('abort')` (`CliDispatcher.ts`, finding #8)

### v0.3.3 — Cleanup and Stability

Low-risk hygiene improvements.

- [ ] Merge duplicate `stderr` listeners into one (`CliDispatcher.ts`, finding #17)
- [ ] Clean up `pendingTimeouts` Map in a top-level `finally` to prevent leaks (`SidebarProvider.ts`, finding #10)
- [ ] Remove dead types `ReviewStatus` and `PendingScores` (`types.ts`, finding #15)
- [ ] Switch `writeFileSync` to `fs.promises.writeFile` in ScoreStore (`ScoreStore.ts`, finding #9)

### v0.4.0 — Quality and Parity

Feature-level improvements warranting a minor version bump.

- [ ] Add unit tests for `PromptBuilder`, `ScoreStore`, `GitHubClient`, `CliDispatcher`  (finding #13)
- [ ] Deprecate `ReviewPanel` or bring to feature parity with sidebar (finding #18)
- [ ] Extract webview JS/HTML from `SidebarProvider.getHtml()` into separate files (finding #14)
- [ ] Deduplicate `escapeHtml` — use shared `ESCAPE_HTML_JS` everywhere (detail finding)
