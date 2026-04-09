# Changelog

All notable changes to the Fleet Review extension will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
