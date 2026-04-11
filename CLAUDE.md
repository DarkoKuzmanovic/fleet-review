# Fleet Review

Multi-AI code review VS Code extension. Dispatches PR reviews to multiple AI CLIs in parallel, posts results to GitHub, and tracks model quality with a scoring leaderboard.

## Project Structure

```
fleet-review/
├── src/                          # VS Code extension (TypeScript)
│   ├── extension.ts              # Entry point — registers sidebar + commands
│   ├── types.ts                  # All interfaces, message types, constants
│   ├── config.ts                 # Extension settings wrapper
│   ├── github/
│   │   └── GitHubClient.ts       # Wraps `gh` CLI: list PRs, fetch diff, post comments
│   ├── review/
│   │   ├── PromptBuilder.ts      # Project detection + audit/merge prompt construction
│   │   ├── CliDispatcher.ts      # Spawns claude/codex/gemini/qwen/copilot via child_process
│   │   └── ReviewOrchestrator.ts # Parallel dispatch, progress tracking, result collection
│   ├── scoring/
│   │   ├── ScoreStore.ts         # JSON file persistence (~/.config/fleet-review/)
│   │   └── GradeImporter.ts      # Watches pending-scores.json, validates, imports
│   └── webview/
│       ├── SidebarProvider.ts    # Main sidebar UI (3 tabs: Review, Grade, Scores)
│       ├── GradingPanel.ts       # Full-page grading with sliders + feedback
│       ├── LeaderboardPanel.ts   # Full-page leaderboard with sparklines
│       └── webviewUtils.ts       # Shared escapeHtml (TS fn + JS string constant)
├── media/                        # Static assets loaded by webviews via URI
│   ├── sidebar.css               # Sidebar styles (extracted from SidebarProvider.ts)
│   └── sidebar.js                # Sidebar script (extracted from SidebarProvider.ts)
├── test/                         # Vitest unit tests
│   ├── CliDispatcher.test.ts
│   ├── GitHubClient.test.ts
│   ├── PromptBuilder.test.ts
│   └── ScoreStore.test.ts
├── shell/                        # Original bash CLI tool
│   ├── fleet-review              # Standalone bash script (independent of extension)
│   ├── Makefile
│   └── LICENSE
├── package.json                  # Extension manifest (commands, views, settings)
├── tsconfig.json                 # Strict TypeScript, ES2022
├── webpack.config.js             # Bundles to dist/extension.js
├── dist/                         # Built output
└── releases/                     # VSIX packages (gitignored)
```

## Architecture

- **No APIs** — all AI calls go through locally installed CLIs (claude, codex, gemini, qwen, copilot)
- **Sidebar-first UI** — main workflow lives in the Activity Bar sidebar via `SidebarProvider`
- **JSON storage** at `~/.config/fleet-review/` (reviews.json, scores.json, last-review.json, pending-scores.json)
- **Claude Code grading** via file handoff: extension writes `last-review.json`, user asks Claude Code to grade and write `pending-scores.json`, extension auto-imports via fs.watch

## CLI Dispatch

Each model is invoked via `child_process.spawn()` in `CliDispatcher.ts`:
- Prompt written to temp file, piped via stdin (avoids shell arg length limits)
- 5-minute timeout per model (configurable via `fleetReview.timeoutSeconds`)
- All models dispatched in parallel via `Promise.allSettled()`
- All spawns use `cwd: os.tmpdir()` to prevent CLI tools from scanning the workspace

| CLI | Command pattern |
|-----|----------------|
| claude | `claude -p --output-format text < prompt.md` |
| codex | `codex exec --dangerously-bypass-approvals-and-sandbox - < prompt.md` |
| gemini | `gemini --model gemini-2.5-flash -e "" -p "Review the provided code" --output-format text < prompt.md` |
| qwen | `qwen -p "" --output-format text < prompt.md` |
| copilot | `copilot -p "" -s --model gpt-5.3-codex --effort high --allow-all-tools < prompt.md` |

## Build & Run

```bash
npm install
npm run compile          # production build
npm run watch            # dev build with watch
npm test                 # run unit tests (vitest)
# Press F5 in VS Code to launch Extension Development Host
```

### Packaging VSIX

Always build VSIX packages into the `releases/` directory (gitignored), not the project root:

```bash
npx @vscode/vsce package -o releases/fleet-review-<version>.vsix
```

## Extension Commands

- `Fleet Review: Start Code Review` — focuses sidebar
- `Fleet Review: Grade Models` — opens full-page grading panel
- `Fleet Review: Grade with Claude Code` — writes last-review.json for Claude Code
- `Fleet Review: Show Leaderboard` — opens full-page leaderboard

## Data Files (~/.config/fleet-review/)

- `reviews.json` — review records with model outputs
- `scores.json` — grading entries (model, score 1-10, feedback, graded-by)
- `last-review.json` — written by extension for Claude Code to read
- `pending-scores.json` — written by Claude Code, auto-imported by extension

### pending-scores.json format (exact shape required)

```json
{
  "reviewId": "<id from last-review.json>",
  "scores": [
    { "model": "gemini", "score": 9, "feedback": "..." },
    { "model": "codex",  "score": 8, "feedback": "..." }
  ]
}
```

`score` must be 1–10. `gradedBy` and `timestamp` are added automatically by the importer — do not include them.

## Webview Pitfall: No `\'` in Template Literals

Webview HTML is generated inside TypeScript template literals (backticks). **Never use `\'` inside a template literal** — it silently becomes `'` and breaks JS string parsing in the rendered `<script>` block. The entire script dies with no error.

Instead of inline `onclick` with escaped quotes, use `document.createElement` + `.onclick` handlers:

```typescript
// BAD — \\' becomes ' inside template literal, breaks the script silently
actions.innerHTML = '<button onclick="vscode.postMessage({type:\'foo\'})">Go</button>';

// GOOD — no escaping issues
var btn = document.createElement('button');
btn.textContent = 'Go';
btn.onclick = function() { vscode.postMessage({ type: 'foo' }); };
actions.appendChild(btn);
```

## Changelog

This project maintains a [CHANGELOG.md](CHANGELOG.md) following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. When making changes:

- Add an entry under `## [Unreleased]` for every user-facing change (bug fix, new feature, breaking change)
- Use `### Added`, `### Fixed`, `### Changed`, `### Removed` subsections
- When releasing, move Unreleased entries to a new `## [x.y.z] - YYYY-MM-DD` section and bump the version in `package.json`

## Known Issues / Design Decisions

- Claude CLI has ~7KB stdin limit — CliDispatcher writes prompt to temp file to work around this
- Codex needs `--dangerously-bypass-approvals-and-sandbox` for headless use
- Extension uses `retainContextWhenHidden` for webview state persistence
- The shell/ bash script is independent — the extension does NOT wrap or depend on it
- GitHub operations use `gh` CLI (must be authenticated via `gh auth login`)
- `GitHubClient` resolves workspace root dynamically via `Config.workspaceRoot` getter to handle workspace changes
- `gh` is invoked with `GH_PROMPT_DISABLED=1` and pager disabled; PR pickers fail into an explicit timeout/error state instead of leaving the webview on `Loading PRs...`
