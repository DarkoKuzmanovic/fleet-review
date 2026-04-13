# Roadmap: v0.3 to v0.4

---

## v0.4.7 — Polish and Reliability

### Code Review Findings (2026-04-12)

Manual audit of the 0.4.6 codebase produced 10 findings. Status tracking below.

| #   | Finding                                              | Location                          | Status |
| --- | ---------------------------------------------------- | --------------------------------- | ------ |
| 1   | `getPRInfo` uses `raw: any`                          | `GitHubClient.ts:93`              | Open   |
| 2   | `writeFileSync` still used for comment temp files    | `GitHubClient.ts:113,148`         | Open   |
| 3   | `getAuditComments` regex matches any word            | `GitHubClient.ts:169`             | Open   |
| 4   | `RetryAllFailed` runs models sequentially            | `SidebarProvider.ts`              | Fixed  |
| 5   | `GradeImporter` silently ignores watcher ENOENT      | `GradeImporter.ts:29`             | Open   |
| 6   | `score` range never validated on manual grade submit | `SidebarProvider.ts:submitGrades` | Fixed  |
| 7   | `handleTimeout` not `async`-safe in cli.ts           | `cli.ts:spawnWithStdin`           | Open   |
| 8   | Version passed as raw string from `packageJSON`      | `extension.ts:33`                 | Fixed  |
| 9   | No truncation of model output before saving          | `ReviewOrchestrator.ts`           | Open   |
| 10  | `modelGlyphHtml` in sidebar.js is a linear scan      | `sidebar.js`                      | Open   |

**Notes per finding:**

1. The `getPRInfo` parse result is typed as `any`; other parse sites in the same file use explicit inline types
2. `postComment` and `postInlineComments` use synchronous `writeFileSync` / `unlinkSync` on the extension host thread
3. `/## Audit by \`(\w+)\``—`\w+` will match provider names with hyphens or dots if they ever appear; better to match against known registry names
4. Outer `try {}` swallows all watcher errors, not just the expected ENOENT; a permissions error goes unnoticed
5. `handleTimeout` is called from a `setTimeout` callback; if `onTimeout` resolves after the process has already settled, a second `settle()` call is made — harmless today because `settle` guards, but the extend path calls `startTimer()` unconditionally after `settled = true` could be set

### Self-Review Fixes (PR #10, 2026-04-12)

Fixes landed after grading the self-review. Consensus findings from 8 models (claude, codex, gemini, qwen, copilot, glm, minimax, trinity):

- [x] Escape `this.version` in the sidebar footer and harden the `packageJSON.version` cast (`extension.ts`, `SidebarProvider.ts`)
- [x] Validate score range and model identity in `submitGrades` on the extension host
- [x] HTML-escape model names in all `sidebar.js` `innerHTML` sinks (checkboxes, progress rows, result detail, grade sliders)
- [x] Replace DOM-based `escapeHtml` in the webview with a pure string-replace that also escapes `"` and `'`
- [x] Parallelize `retryAllFailed` with `Promise.allSettled`
- [x] Use `Object.create(null)` for the `checkModelHealth` result map and the sidebar `chunkBuffers`
- [x] Guard `tokenUsage` aggregation against missing `prompt` / `completion` fields
- [x] Clear `chunkBuffers` on `reviewError` as well as `reviewComplete`

### Remaining Bug Fixes

- [ ] **#1:** Replace `raw: any` in `getPRInfo` with a typed inline interface (`GitHubClient.ts`)
- [ ] **#2:** Replace synchronous `writeFileSync`/`unlinkSync` with `fs.promises` equivalents in `postComment` and `postInlineComments` (`GitHubClient.ts`)
- [ ] **#3:** Tighten `getAuditComments` regex to match only known provider names (`GitHubClient.ts`)
- [ ] **#5:** Surface non-ENOENT errors in `GradeImporter` watcher instead of swallowing all errors (`GradeImporter.ts`)
- [ ] **#7:** Make `handleTimeout` async-safe — guard against double `settle()` calls and unconditional `startTimer()` after settlement (`cli.ts`)
- [ ] **#9:** Clamp model output to a configurable max length (e.g. 200 KB) before persisting (`ReviewOrchestrator.ts`)
- [ ] **#10:** Replace linear-scan `modelGlyphHtml` with a lookup object built at init time (`sidebar.js`)

### Small Feature Improvements

**UI / UX**

- [ ] **Merge button visibility** — `btn-merge` should appear only after every selected model has finished (success or fail), so users can't trigger a half-baked merge
- [ ] **Provider display names in progress rows** — use `displayName` (e.g. `DeepSeek V3.2`) instead of raw `name` (e.g. `deepseek`) from `__FR_CONFIG.providers`
- [ ] **Token usage for HTTP models** — surface `prompt + completion` token counts in the results card next to the KB size (data already in `ModelResult.tokenUsage`)
- [ ] **Review age in history list** — replace absolute timestamps with relative age strings ("2 h ago", "yesterday"); keep full ISO date in `title` attribute for hover
- [ ] **Last-review badge on History tab** — show a "latest" chip next to the most recent history entry for quick identification
- [ ] **Auto-open Grading tab after review completes** — optional (`fleetReview.autoOpenGrade: boolean`) auto-switch to Grade tab removes a manual step

**Commands / Settings**

- [ ] **`Fleet Review: Copy Last Review ID`** — one-liner command that writes the latest `review.id` to the clipboard for bug reports or `pending-scores.json`
- [ ] **`fleetReview.maxOutputKB` setting** — expose the output-size cap as a user setting (default 200) so power users can raise it for verbose models
- [ ] **HTTP provider health check: verify key format** — basic length check (e.g. > 10 chars) to catch obvious typos/truncations before showing a green dot

**Reliability**

- [ ] **Abort in-progress merge** — wire up an `AbortController` to `runMerge` the same way `runReview` does, so a thinking model can't peg for 10 minutes

---

## Audit Triage: Verified vs. Hallucinated

Based on Qwen Code's audit (2026-04-10), verified against actual codebase.

### Confirmed Real (15 findings)

| #        | Finding                                        | Location                                  | Notes                                                              |
| -------- | ---------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| 1        | ScoreStore data loss on corrupted JSON         | `ScoreStore.ts:72-73`                     | Non-ENOENT errors silently return `[]`, discarding all cached data |
| 2        | `-pid` kill fails on Windows                   | `CliDispatcher.ts:247`                    | `process.kill(-pid)` is Unix-only                                  |
| 3        | Triple backticks in diff break prompt          | `PromptBuilder.ts:65-67`                  | Plain ` ``` ` fence with unescaped diff content                    |
| 4        | `JSON.parse` without try/catch in GitHubClient | `GitHubClient.ts:48,85,155`               | Bare `JSON.parse` on `gh` stdout                                   |
| 6        | GitHub comment posting silently fails          | `ReviewOrchestrator.ts:97-99`             | Bare `catch {}`, user never learns posting failed                  |
| 7        | `runMerge` hardcodes `claude`                  | `ReviewOrchestrator.ts:174`               | `dispatch('claude', ...)` with no fallback                         |
| 8        | Fragile timeout detection via string matching  | `CliDispatcher.ts:208`                    | `err.message.includes('abort')` in `httpDispatch` only             |
| 9        | Synchronous file writes block event loop       | `ScoreStore.ts:55,97,104,184`             | `writeFileSync` on main thread                                     |
| 10       | `pendingTimeouts` Map leak on crash            | `SidebarProvider.ts:19`                   | Entries stay if review crashes before resolution                   |
| 13       | Zero tests                                     | Entire project                            | No `*.test.ts` files exist                                         |
| 14       | ~1600-line `getHtml()`                         | `SidebarProvider.ts`                      | 1606 lines total                                                   |
| 15       | Dead types                                     | `types.ts:9,82-89`                        | `ReviewStatus` and `PendingScores` unused                          |
| 17       | Duplicate `stderr` listeners                   | `CliDispatcher.ts:289,357`                | Two separate `proc.stderr.on('data')` handlers                     |
| 18       | `ReviewPanel` degraded features                | `ReviewPanel.ts`                          | No retry, streaming, progress, or timeout support                  |
| (detail) | Duplicate `escapeHtml`                         | `GradingPanel.ts:221` + `webviewUtils.ts` | Module-level and inline webview copies                             |

### Hallucinated or Wrong (3 findings)

| #        | Claim                                               | Verdict                                                                                                |
| -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 12       | "Pending scores deleted before import event fires"  | **Wrong.** Code saves first, deletes second. Already safe.                                             |
| 5        | "`.includes()` throws if overrides is not an array" | **Overstated.** VS Code config API with default array + schema enforcement makes this near-impossible. |
| (detail) | "modelTimeouts reads config in a loop per model"    | **Misleading.** VS Code config API caches in memory, no IPC per iteration.                             |

### Not Implementable / Won't Fix

| #   | Finding                        | Why                                                                                    |
| --- | ------------------------------ | -------------------------------------------------------------------------------------- |
| 2   | Windows process group kill     | Target audience uses Unix CLIs. No demand yet.                                         |
| 11  | CSP `unsafe-inline`            | Unavoidable without extracting webview JS to files (large refactor, deferred to v0.4). |
| 16  | `onStartupFinished` activation | `fs.watch` for auto-import needs early start. Marginal benefit to change.              |

---

## Release Plan

### v0.3.1 — Data Safety

Prevent silent data loss. Smallest diff, highest impact.

- [x] Re-throw non-ENOENT errors in `loadReviews()` / `loadScores()` instead of returning `[]` (`ScoreStore.ts`, finding #1)
- [x] Wrap `JSON.parse` calls in `listPRs`, `getPRInfo`, `getAuditComments` with try/catch (`GitHubClient.ts`, finding #4)
- [x] Use `````diff` (4+ backtick) fences to prevent diff content breaking prompt structure (`PromptBuilder.ts`, finding #3)

### v0.3.2 — User Feedback on Failures

Surface errors that are currently swallowed silently.

- [x] Surface `postedToGitHub: false` as a warning notification when comment posting fails (`ReviewOrchestrator.ts`, finding #6)
- [x] Use `Config.defaultModels[0]` for merge synthesis instead of hardcoded `'claude'` (`ReviewOrchestrator.ts`, finding #7)
- [x] Check `signal.aborted` or `err.name === 'AbortError'` in `httpDispatch` instead of `err.message.includes('abort')` (`CliDispatcher.ts`, finding #8)

### v0.3.3 — Cleanup and Stability

Low-risk hygiene improvements.

- [x] Merge duplicate `stderr` listeners into one (`CliDispatcher.ts`, finding #17)
- [x] Clean up `pendingTimeouts` Map in a top-level `finally` to prevent leaks (`SidebarProvider.ts`, finding #10)
- [x] Remove dead types `ReviewStatus` and `PendingScores` (`types.ts`, finding #15)
- [x] Switch `writeFileSync` to `fs.promises.writeFile` in ScoreStore (`ScoreStore.ts`, finding #9)
- [x] Wire up Review History Drawer UI — backend plumbing (`requestReviewHistory`, `getRecentReviews`) exists, needs sidebar rendering (from `ideas.md`)

### v0.4.0 — Quality and Parity

Feature-level improvements warranting a minor version bump.

- [x] Add unit tests for `PromptBuilder`, `ScoreStore`, `GitHubClient`, `CliDispatcher` (finding #13)
- [x] Deprecate `ReviewPanel` or bring to feature parity with sidebar (finding #18)
- [x] Extract webview JS/HTML from `SidebarProvider.getHtml()` into separate files (finding #14)
- [x] Deduplicate `escapeHtml` — use shared `ESCAPE_HTML_JS` everywhere (detail finding)
