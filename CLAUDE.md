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
│   │   ├── CliDispatcher.ts      # Thin shim — resolves a provider from the registry and delegates
│   │   ├── ReviewOrchestrator.ts # Parallel dispatch, progress tracking, result collection
│   │   └── providers/
│   │       ├── types.ts          # CliProvider | HttpProvider discriminated union, HttpGateway
│   │       ├── builtins.ts       # Built-in providers (claude/codex/gemini/qwen/copilot + glm) and gateways (nanogpt, openrouter)
│   │       ├── registry.ts       # ProviderRegistry — merges built-ins + custom, reads keys from SecretStorage
│   │       ├── cli.ts            # runCli(provider, prompt, ctx) — spawn + stdin + timeout
│   │       └── http.ts           # runHttp(provider, gateway, apiKey, prompt, ctx) — SSE streaming
│   ├── scoring/
│   │   ├── ScoreStore.ts         # JSON file persistence (~/.config/fleet-review/)
│   │   └── GradeImporter.ts      # Watches pending-scores.json, validates, imports
│   └── webview/
│       ├── SidebarProvider.ts    # Main sidebar UI (3 tabs: Review, Grade, Scores)
│       ├── GradingPanel.ts       # Full-page grading with sliders + feedback
│       ├── LeaderboardPanel.ts   # Full-page leaderboard with sparklines
│       └── webviewUtils.ts       # Shared escapeHtml (TS fn + JS string constant) + safeJsonForHtml (XSS-safe JSON injection)
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

- **Pluggable providers** — `ProviderRegistry` holds a discriminated union of `CliProvider | HttpProvider`. Built-ins live in [src/review/providers/builtins.ts](src/review/providers/builtins.ts); custom entries come from `fleetReview.customProviders` / `fleetReview.customGateways`.
- **CLI models** spawn local binaries via `child_process.spawn()` (claude, codex, gemini, qwen, copilot)
- **HTTP models** call OpenAI-compatible gateways — built-in `nanogpt` hosts `glm`; `openrouter` is registered as a gateway by default so custom providers can reference it without extra config
- **Gateway API keys** live in VS Code SecretStorage under `fleet-review.gateway.<name>.apiKey`. Env-var fallback: `FLEET_REVIEW_<GATEWAY>_API_KEY`. The `Fleet Review: Set Gateway API Key` command is the supported way to set them.
- **Sidebar-first UI** — main workflow lives in the Activity Bar sidebar via `SidebarProvider`
- **JSON storage** at `~/.config/fleet-review/` (reviews.json, scores.json, last-review.json, pending-scores.json)
- **Claude Code grading** via file handoff: extension writes `last-review.json`, user asks Claude Code to grade and write `pending-scores.json`, extension auto-imports via fs.watch

## Provider Dispatch

`CliDispatcher.dispatch(name, prompt, ...)` resolves a provider from the registry and calls either `runCli` or `runHttp`:

- CLI path: prompt written to temp file, piped via stdin (avoids shell arg length limits), parallel via `Promise.allSettled()`, `cwd: os.tmpdir()` to prevent workspace scanning
- HTTP path: OpenAI-compatible chat-completions streaming (SSE), token usage parsed from the final frame
- Default timeout 5 minutes (configurable via `fleetReview.timeoutSeconds`); any provider can override via its own `timeoutSeconds`

Built-in command patterns:

| Provider | Kind | Command / gateway + model                                                                     |
| -------- | ---- | --------------------------------------------------------------------------------------------- |
| claude   | cli  | `claude -p --output-format text`                                                              |
| codex    | cli  | `codex -q --model gpt-5.3-codex -`                                                            |
| gemini   | cli  | `gemini -e "" -p "Review the provided code" --output-format text`                             |
| qwen     | cli  | `qwen -p "" --output-format text`                                                             |
| copilot  | cli  | `copilot -p "" -s --model gpt-5.3-codex`                                                      |
| glm      | http | gateway `nanogpt`, modelId `zai-org/glm-5:thinking`                                           |

Adding a new model is a settings-only change — no code edits. Example: to add `minimax/minimax-m2.7` via Nano-GPT, append an entry to `fleetReview.customProviders` with `kind: "http"`, `gateway: "nanogpt"`, and the desired `modelId`, then set the gateway key once via the command palette.

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
    { "model": "codex", "score": 8, "feedback": "..." }
  ]
}
```

`score` must be 1–10. `gradedBy` and `timestamp` are added automatically by the importer — do not include them.

## Webview Pitfall: No `\'` in Template Literals

Webview HTML is generated inside TypeScript template literals (backticks). **Never use `\'` inside a template literal** — it silently becomes `'` and breaks JS string parsing in the rendered `<script>` block. The entire script dies with no error.

Instead of inline `onclick` with escaped quotes, use `document.createElement` + `.onclick` handlers:

```typescript
// BAD — \\' becomes ' inside template literal, breaks the script silently
actions.innerHTML = "<button onclick=\"vscode.postMessage({type:'foo'})\">Go</button>";

// GOOD — no escaping issues
var btn = document.createElement("button");
btn.textContent = "Go";
btn.onclick = function () {
  vscode.postMessage({ type: "foo" });
};
actions.appendChild(btn);
```

## Webview Pitfall: Raw `JSON.stringify` in `<script>` Blocks

Never inject `JSON.stringify(data)` directly into a `<script>` block. If any string value contains `</script>`, it closes the script tag and allows script injection.

Use `safeJsonForHtml(data)` from `webviewUtils.ts` instead — it escapes `<` and `>` so the JSON payload is safe to embed:

```typescript
// BAD — provider name or model output containing </script> breaks out of the script block
const config = `<script>window.__FR = ${JSON.stringify(providers)};</script>`;

// GOOD
import { safeJsonForHtml } from "../webview/webviewUtils";
const config = `<script>window.__FR = ${safeJsonForHtml(providers)};</script>`;
```

## Changelog

This project maintains a [CHANGELOG.md](CHANGELOG.md) following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. When making changes:

- Add an entry under `## [Unreleased]` for every user-facing change (bug fix, new feature, breaking change)
- Use `### Added`, `### Fixed`, `### Changed`, `### Removed` subsections
- When releasing, move Unreleased entries to a new `## [x.y.z] - YYYY-MM-DD` section and bump the version in `package.json`

## Known Issues / Design Decisions

- Claude CLI has ~7KB stdin limit — CliDispatcher writes prompt to temp file to work around this
- Codex is invoked in non-interactive mode with `codex -q --model gpt-5.3-codex -` (the `--dangerously-bypass-approvals-and-sandbox` flag was removed in v0.4.7 to close a zero-click RCE path; same for `copilot`'s `--allow-all-tools`)
- Extension uses `retainContextWhenHidden` for webview state persistence
- The shell/ bash script is independent — the extension does NOT wrap or depend on it
- GitHub operations use `gh` CLI (must be authenticated via `gh auth login`)
- `GitHubClient` resolves workspace root dynamically via `Config.workspaceRoot` getter to handle workspace changes
- `gh` is invoked with `GH_PROMPT_DISABLED=1` and pager disabled; PR pickers fail into an explicit timeout/error state instead of leaving the webview on `Loading PRs...`
