# Roadmap: v0.3 to v0.4

---

## v0.4.7 — Polish and Reliability

### Code Review Findings (2026-04-12)

Findings from a manual audit of the 0.4.6 codebase.

| # | Finding | Location | Notes |
|---|---------|----------|-------|
| 1 | `getPRInfo` uses `raw: any` | `GitHubClient.ts:93` | The `getPRInfo` parse result is typed as `any`; other parse sites in the same file use explicit inline types |
| 2 | `writeFileSync` still used for comment temp files | `GitHubClient.ts:113,148` | `postComment` and `postInlineComments` use synchronous `writeFileSync` / `unlinkSync` on the extension host thread |
| 3 | `getAuditComments` regex matches any word | `GitHubClient.ts:169` | `/## Audit by \`(\w+)\`` — `\w+` will match provider names with hyphens or dots if they ever appear; better to match against known registry names |
| 4 | `RetryAllFailed` runs models sequentially | `SidebarProvider.ts` | `retryAllFailed()` loops `for (const model of failedModels)` with `await` — should be parallel like the initial run |
| 5 | `GradeImporter` silently ignores watcher ENOENT | `GradeImporter.ts:29` | Outer `try {}` swallows all watcher errors, not just the expected ENOENT; a permissions error goes unnoticed |
| 6 | `score` range never validated on manual grade submit | `SidebarProvider.ts:submitGrades` | The webview sends scores from a slider (min/max enforced by the DOM), but the host never checks `1 ≤ score ≤ 10` — a crafted message can store an out-of-range score |
| 7 | `handleTimeout` not `async`-safe in cli.ts | `cli.ts:spawnWithStdin` | `handleTimeout` is called from a `setTimeout` callback; if `onTimeout` resolves after the process has already settled, a second `settle()` call is made — harmless today because `settle` guards, but the extend path calls `startTimer()` unconditionally after `settled = true` could be set |
| 8 | Version passed as raw string from `packageJSON` | `extension.ts:33` | `context.extension.packageJSON.version` is typed as `any`; the cast `as string` is safe today but an explicit check or use of the `ExtensionContext.extension.packageJSON` type would be safer |
| 9 | No truncation of model output before saving | `ReviewOrchestrator.ts` | A runaway model can produce megabytes; `reviews.json` will grow unbounded — a simple max-length cap on `result.stdout` before storing would prevent disk bloat |
| 10 | `modelGlyphHtml` in sidebar.js is a linear scan | `sidebar.js` | Called once per model per tick of `renderResults` — not a hot path, but building it as a lookup object at init time is cleaner |

### Bug Fixes

- [ ] Replace `raw: any` in `getPRInfo` with a typed inline interface (`GitHubClient.ts`, finding #1)
- [ ] Replace synchronous `writeFileSync`/`unlinkSync` with `fs.promises` equivalents in `postComment` and `postInlineComments` (`GitHubClient.ts`, finding #2)
- [ ] Clamp model output to a configurable max length (e.g. 200 KB) before persisting in `ReviewOrchestrator` (`finding #9`)
- [ ] Validate `1 ≤ score ≤ 10` in `submitGrades` on the extension host side (`SidebarProvider.ts`, finding #6)
- [ ] Run `retryAllFailed` models in parallel with `Promise.allSettled` instead of sequentially (`SidebarProvider.ts`, finding #4)

### Small Feature Improvements

1. **Merge report button visible only when all models have results** — `btn-merge` is always shown; it should appear only after every selected model has finished (success or fail), so users can't trigger a half-baked merge.

2. **Last-review badge on the History tab** — show a "latest" chip next to the most recent history entry so it's immediately clear which was the last run without reading timestamps.

3. **Provider display names in progress rows** — the progress view shows the provider `name` (e.g. `deepseek`) rather than `displayName` (e.g. `DeepSeek V3.2`); use `displayName` from `__FR_CONFIG.providers`.

4. **Token usage shown for HTTP models** — `ModelResult.tokenUsage` is already stored; surface `prompt + completion` token counts in the results card next to the KB size.

5. **Abort in-progress merge** — `runMerge` dispatches to a single model but there is no cancel path; a thinking model could peg it for 10 minutes. Wire up an `AbortController` the same way `runReview` does.

6. **Review age in history list** — the history drawer shows timestamps; replace with relative age strings ("2 h ago", "yesterday") for faster scanning. Absolute ISO date can live in `title` attribute for hover.

7. **`Fleet Review: Copy Last Review ID` command** — a one-liner command that writes the latest `review.id` to the clipboard. Saves hunting through `reviews.json` when filing bug reports or manually writing `pending-scores.json`.

8. **Health check for HTTP providers: verify key format before showing green dot** — currently any non-empty string stored in SecretStorage makes the dot green. A basic length check (e.g. > 10 chars) would catch obvious typos/truncations.

9. **`fleetReview.maxOutputKB` setting** — expose the output-size cap (finding #9 above) as a user setting with a default of 200, so power users running large diffs with verbose models can raise it.

10. **Auto-open Grading tab after review completes** — after all models finish, the sidebar stays on the Review tab. Offering an optional auto-switch to Grade (`fleetReview.autoOpenGrade: boolean`) removes a manual step for users who always grade right after reviewing.

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
