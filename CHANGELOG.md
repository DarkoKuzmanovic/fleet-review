# Changelog

All notable changes to the Fleet Review extension will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-04-11

### Fixed

- ScoreStore now re-throws non-ENOENT errors in `loadReviews()` and `loadScores()` instead of silently returning empty arrays on corrupted data
- GitHubClient wraps `JSON.parse()` calls in `listPRs`, `getPRInfo`, and `getAuditComments` with descriptive error messages
- PromptBuilder uses quadruple-backtick fences for diff blocks to prevent breakage when diffs contain triple backticks

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
