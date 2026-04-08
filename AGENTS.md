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
│       ├── ReviewPanel.ts        # Standalone webview panel (alternate to sidebar)
│       ├── GradingPanel.ts       # Full-page grading with sliders + feedback
│       └── LeaderboardPanel.ts   # Full-page leaderboard with sparklines
├── shell/                        # Original bash CLI tool
│   ├── fleet-review              # Standalone bash script (independent of extension)
│   ├── Makefile
│   └── LICENSE
├── package.json                  # Extension manifest (commands, views, settings)
├── tsconfig.json                 # Strict TypeScript, ES2022
├── webpack.config.js             # Bundles to dist/extension.js
└── dist/                         # Built output
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

| CLI     | Command pattern                                                       |
| ------- | --------------------------------------------------------------------- |
| claude  | `claude -p --output-format text < prompt.md`                          |
| codex   | `codex exec --dangerously-bypass-approvals-and-sandbox - < prompt.md` |
| gemini  | `gemini -p "Audit this PR" --output-format text < prompt.md`          |
| qwen    | `qwen -p "Audit this PR" --output-format text < prompt.md`            |
| copilot | `copilot -p "Audit this PR" < prompt.md`                              |

## Build & Run

```bash
npm install
npm run compile          # production build
npm run watch            # dev build with watch
# Press F5 in VS Code to launch Extension Development Host
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

## Known Issues / Design Decisions

- Claude CLI has ~7KB stdin limit — CliDispatcher writes prompt to temp file to work around this
- Codex needs `--dangerously-bypass-approvals-and-sandbox` for headless use
- Extension uses `retainContextWhenHidden` for webview state persistence
- The shell/ bash script is independent — the extension does NOT wrap or depend on it
- GitHub operations use `gh` CLI (must be authenticated via `gh auth login`)
- `GitHubClient` resolves workspace root dynamically via `Config.workspaceRoot` getter to handle workspace changes
- Run `gh` from the extension with `GH_PROMPT_DISABLED=1` and pager disabled, and make PR pickers fail into an explicit timeout/error state instead of leaving the webview on `Loading PRs...`
