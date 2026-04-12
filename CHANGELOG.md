# Changelog

All notable changes to the Fleet Review extension will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.5] - 2026-04-12

### Added

- `ModelProvider` abstraction in `src/review/providers/` — discriminated union of `CliProvider | HttpProvider` with a `ProviderRegistry` that merges built-ins with user-registered providers
- `HttpGateway` registry — multiple HTTP providers can share one base URL + API key (Nano-GPT, OpenRouter built in)
- `fleetReview.customProviders` setting — register additional CLI or HTTP models without editing code
- `fleetReview.customGateways` setting — register additional OpenAI-compatible HTTP gateways
- `Fleet Review: Set Gateway API Key` command — stores keys in VS Code `SecretStorage` (encrypted per user, never in `settings.json`)
- Dynamic merge-report Consensus Summary table — columns reflect the models that actually participated, not a fixed list of five
- Env-var fallback for gateway keys: `FLEET_REVIEW_<GATEWAY>_API_KEY` (e.g. `FLEET_REVIEW_NANOGPT_API_KEY`)

### Changed

- `CliDispatcher` is now a thin shim over `runCli` / `runHttp` resolved through `ProviderRegistry`; per-model dispatch switch removed
- `ReviewOrchestrator` takes a `ProviderRegistry` and reads per-provider timeouts from `provider.defaultTimeoutMs` instead of `Config.timeoutMsForModel`
- `fleetReview.defaultModels` no longer enforces an enum of built-in names — any registered provider name is valid
- Sidebar model health check uses the registry: CLI providers run `which <command>`, HTTP providers check whether a gateway API key is set

### Removed

- `MODEL_NAMES` const and `API_MODELS` set from `src/types.ts` — replaced by runtime registry lookups
- `fleetReview.geminiModel` setting — to use a specific Gemini model, add a custom provider entry
- `fleetReview.nanoGptApiKey` setting — use the new `Set Gateway API Key` command instead
- `fleetReview.modelTimeouts` setting — set `timeoutSeconds` on the individual custom provider entry
- `Config.timeoutMsForModel`, `Config.modelTimeouts`, `Config.geminiModel`, `Config.nanoGptApiKey` getters

### Migration

- Existing Nano-GPT users: re-enter the key once via `Fleet Review: Set Gateway API Key` → `nanogpt`, or set `FLEET_REVIEW_NANOGPT_API_KEY` in the environment
- Existing `modelTimeouts` overrides: define a custom provider entry with the built-in's shape and your desired `timeoutSeconds`

## [0.4.0] - 2026-04-12

### Added

- Unit test suite with vitest: 64 tests covering `PromptBuilder`, `ScoreStore`, `GitHubClient`, and `CliDispatcher`
- Shared TypeScript-level `escapeHtml()` export in `webviewUtils.ts` for template-time HTML escaping

### Changed

- Extracted sidebar CSS and JavaScript from `SidebarProvider.getHtml()` into `media/sidebar.css` and `media/sidebar.js`, reducing the method from ~1300 lines to ~120
- Sidebar CSP now loads CSS from file (`style-src ${cspSource} 'unsafe-inline'`) — `'unsafe-inline'` retained for inline `style` attributes used by progress rings and model glyphs
- `GradingPanel` uses shared `ESCAPE_HTML_JS` and `escapeHtml` from `webviewUtils` instead of local duplicates

### Fixed

- Sidebar `style-src` CSP now includes `'unsafe-inline'` to avoid blocking inline `style` attributes on model glyphs and progress rings
- `querySelector` calls for elapsed-time/bytes counters now use `getElementById` + child query to avoid CSS parsing issues with dotted model names
- TypeScript-level `escapeHtml()` now escapes single quotes (`'` → `&#39;`) for defense-in-depth in single-quoted attribute contexts
- `package-lock.json` version synced to match `package.json` at 0.4.0

### Removed

- `ReviewPanel` — unused standalone webview panel superseded by the sidebar; had no streaming, retry, grading, timeout, or comparison support

## [0.3.3] - 2026-04-12

### Fixed

- ScoreStore async writes now serialize via a promise queue to prevent concurrent read-modify-write race conditions
- GradeImporter guards against duplicate imports when `fs.watch` fires multiple events for a single file write
- `gradeWithClaude` and `submitGrades` are now awaited in SidebarProvider's message handler to prevent unhandled rejections
- GLM timeout abort detection now distinguishes user cancellation (`signal.aborted`) from timeout-triggered `AbortError`

### Changed

- Merged duplicate `stderr` listeners into a single handler in `CliDispatcher` that both logs and accumulates
- Extracted `clearPendingTimeouts()` helper in `SidebarProvider` to prevent Map leaks on review crash
- Switched `writeFileSync` to `fs.promises.writeFile` in `ScoreStore` for non-blocking file I/O

### Removed

- Dead types `ReviewStatus` and `PendingScores` from `types.ts`

## [0.3.2] - 2026-04-11

### Fixed

- GitHub comment posting failures now surface a warning notification and log to the output channel instead of being silently swallowed
- Merge synthesis uses the first configured default model instead of hardcoded `'claude'`
- GLM abort detection checks `signal.aborted` and `AbortError` name before falling back to string matching
- Abort error message now distinguishes user cancellation from timeout when `AbortError` fires without `signal.aborted`
- GitHub comment failures aggregate into a single warning toast per review instead of one per model
- Extracted `logCommentFailure` helper to deduplicate error-handling across `runReview` and `retrySingleModel`

## [0.3.1] - 2026-04-11

### Fixed

- ScoreStore now re-throws non-ENOENT errors in `loadReviews()` and `loadScores()` instead of silently returning empty arrays on corrupted data
- GitHubClient wraps `JSON.parse()` calls in `listPRs`, `getPRInfo`, and `getAuditComments` with descriptive error messages
- PromptBuilder uses quadruple-backtick fences for diff blocks to prevent breakage when diffs contain triple backticks
- ScoreStore error messages now include file path context and preserve original error cause
- GitHubClient JSON parse errors preserve original cause and handle empty CLI output
- Restored type safety for `listPRs` parsed output (regression from initial fix)
- PromptBuilder dynamically computes backtick fence length from diff content instead of hardcoded quadruple fences
- Added error boundaries at all ScoreStore caller sites to prevent unhandled throws in webview handlers, command handlers, and background callbacks

## [0.3.0] - 2026-04-10

### Added

- GLM model now streams output via SSE — byte counters and chunk previews update live instead of all-at-once
- Collapsible output blocks with copy button — each model's output is independently collapsible with a hover-to-reveal copy button
- In-extension Claude Code grading prompt — renders a copy-able prompt block in the Grade tab instead of a disappearing notification
- Review comparison view — "Compare Models" button shows consensus vs. unique findings across models with tabbed output
- Inline PR review comments — findings with file:line references are posted as inline GitHub review comments at the correct position
- Model cost tracking — token usage (prompt/completion) displayed in summary card for API-based models (GLM)
- Configurable review prompts per project type via `fleetReview.projectPrompts` setting
- Configurable extra hints per project type via `fleetReview.projectHints` setting

### Fixed

- Clock no longer resets chunk preview during streaming — elapsed time and byte count render in separate DOM elements
- Extended timeout progress ring now pulses red with a glow effect to visually distinguish "borrowed time" from normal progress
- History list no longer overflows horizontally — CSS truncation with ellipsis replaces brittle `substring(0, 40)`
- Inline PR comments now post individually — one invalid line number no longer silently drops the entire batch
- GLM timeout now covers connection/DNS/TLS stalls — timer starts before `fetch()`, not after headers arrive
- Custom `projectPrompts` no longer breaks inline comment and comparison parsing — output format section is always appended
- GLM `handleTimeout` no longer calls `abort()` after the stream has already settled
- Extended-timeout ring pulse animation (`.extended` class) is now removed when a model completes
- Temp files in GitHubClient use `crypto.randomUUID()` instead of predictable `Date.now()` names
- `parseInlineFindings` now normalizes file paths (strips leading `./`) and uses a more lenient line-number regex matching the webview parser
- SSE stream parser now flushes the trailing buffer after the reader ends, preventing loss of the final chunk
- Clipboard copy buttons now handle rejection (`.catch()`) instead of leaving unhandled promise rejections
- Token count display uses `>=` instead of `>` for the 1000-token formatting threshold

## [0.2.0] - 2026-04-10

### Added

- Skeleton loading states with shimmer animation for PR dropdown, scores table, and progress rows
- Review summary card showing completion stats, durations, GitHub post count, and output size
- Timeout progress ring with color-coded conic-gradient (green → amber → red)
- One-click retry for failed/timed-out models with per-model and bulk retry
- Diff size warning banner when PR exceeds configurable line threshold
- Model health check dots showing CLI availability (green/red) on model checkboxes
- Streamed first findings — live preview of partial output during review
- Review history drawer showing past reviews with clickable navigation
- Smart model defaults — "Suggested" badge on models with high average scores
- `fleetReview.diffSizeWarningThreshold` setting (default 1500 lines)

### Fixed

- Health check now uses `where` on Windows instead of Unix-only `which`
- Model name validation prevents prototype pollution via crafted webview messages
- Streaming preview now works during retry (missing `onText` callback wired through)
- AbortController scoped locally in retry to prevent orphaning concurrent operations
- "Retry All Failed" now fires a single `reviewComplete` instead of N full re-renders
- Progress rows render real DOM immediately — removed 300ms skeleton race that dropped early updates
- Stream chunk buffer capped to 4KB to prevent unbounded memory growth
- History rendering uses `createElement`/`textContent` instead of `innerHTML`
- Retry buttons disabled when viewing history items to prevent wrong-context corruption

## [0.1.2] - 2026-04-09

### Added
- Extension icon assets from `media/icon.svg` with packaged marketplace icon at `media/icon.png`

### Changed
- Review prompts now cap the file list to 50 entries and summarize the remainder for large PRs

### Fixed
- Webview CSP now interpolates `webview.cspSource` correctly so model glyph icons render
- Glyph image URIs in webview script are JSON-escaped before injection
- Glyph HTML rendering now escapes image URI attributes defensively
- Timeout extension button now uses nullish fallback (`??`) to match backend timeout resolution

## [0.1.1] - 2026-04-09

### Fixed
- ScoreStore cache now updates after successful disk write, not before — prevents phantom data on write failure
- ScoreStore only caches empty array for `ENOENT`; parse errors and permission failures are logged instead of silently swallowed
- ScoreStore catch blocks return the cached reference instead of a detached empty array
- `pendingTimeouts.clear()` in SidebarProvider now resolves all pending promises before clearing, preventing leaked async chains
- Temp prompt filenames use `crypto.randomUUID()` instead of `Date.now()` to prevent symlink attacks and collisions
- Merged-report post errors routed to VS Code OutputChannel instead of `console.error`
- `openGradePanel` command execution is now awaited to catch rejections

### Added
- `ScoreStore.invalidateCache()` method for external callers to force a fresh disk read
- GradeImporter invalidates ScoreStore cache before reading pending scores, so external writes are visible
- ReviewOrchestrator accepts optional OutputChannel for user-visible error logging

## [0.1.0] - 2026-04-06

### Added
- Initial release: multi-AI code review for GitHub PRs
- Sidebar UI with Review, Grade, and Scores tabs
- Parallel CLI dispatch for claude, codex, gemini, qwen, copilot
- GLM model support via Nano-GPT HTTP API
- Automatic GitHub comment posting per model
- Manual grading with sliders and feedback
- Claude Code grading via file handoff (`last-review.json` / `pending-scores.json`)
- Auto-import of pending scores via filesystem watcher
- Leaderboard with sparkline trend charts
- Configurable timeouts with extend/kill UI per model
- Shared `escapeHtml` utility for webview script deduplication
