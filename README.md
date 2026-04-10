# Fleet Review

VS Code extension that dispatches GitHub PR reviews to multiple AI CLIs in parallel, posts individual audits as PR comments, then synthesizes a merged report ranked by consensus.

```text
PR Diff ──┬──> Claude   ──┐
          ├──> Gemini   ──┤
          ├──> Codex    ──┼──> Merged Report (deduplicated, ranked by consensus)
          ├──> Qwen     ──┤
          └──> Copilot  ──┘
```

Each AI independently reviews the diff and posts findings as a PR comment. Comments post as each model finishes — no waiting for stragglers. Then Claude synthesizes all findings into a single prioritized report.

## Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated via `gh auth login`
- At least one AI CLI installed:

| CLI | Install | Notes |
| ----- | ------- | ----- |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm i -g @anthropic-ai/claude-code` | Used for merge synthesis |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm i -g @google/gemini-cli` | Defaults to Auto model (Gemini 3) |
| [Codex CLI](https://github.com/openai/codex) | `npm i -g @openai/codex` | Needs `--dangerously-bypass-approvals-and-sandbox` |
| [Qwen CLI](https://github.com/QwenLM/qwen-code) | `npm i -g @qwen-code/qwen-code` | |
| [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli) | `npm i -g @githubnext/ghcs` | |

## Install

```bash
git clone https://github.com/DarkoKuzmanovic/fleet-review.git
cd fleet-review
npm install
npm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host.

## Usage

1. Open a project with a GitHub remote in VS Code
2. Click the **Fleet Review** icon in the Activity Bar (sidebar)
3. Select a PR and choose which models to run — health dots show CLI availability, and top-scoring models get a "Suggested" badge
4. Click **Start Review** — models dispatch in parallel with progress rings and live streaming previews
5. Results post to GitHub as each model finishes — failed models can be retried individually or in bulk
6. Review past results from the history drawer at the bottom of the Review tab

### Commands

| Command | Description |
| ------- | ----------- |
| `Fleet Review: Start Code Review` | Opens sidebar and starts review flow |
| `Fleet Review: Grade Models` | Opens full-page grading panel with sliders |
| `Fleet Review: Grade with Claude Code` | Writes review data for Claude Code to grade |
| `Fleet Review: Show Leaderboard` | Opens full-page leaderboard with sparklines |

## Configuration

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `fleetReview.defaultModels` | `["claude", "gemini", "qwen"]` | Models to select by default |
| `fleetReview.geminiModel` | `auto` | Gemini model (`auto`, `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-*-preview`) |
| `fleetReview.nanoGptApiKey` | `""` | Nano-GPT API key used by GLM reviews (falls back to `NANO_GPT_API_KEY`) |
| `fleetReview.timeoutSeconds` | `300` | Timeout per model (seconds) |
| `fleetReview.modelTimeouts` | `{}` | Per-model timeout overrides (seconds) for `claude`, `codex`, `gemini`, `qwen`, `copilot`, and `glm` |
| `fleetReview.diffSizeWarningThreshold` | `1500` | Warn before reviewing PRs with more changed lines than this |
| `fleetReview.dataDir` | `~/.config/fleet-review` | Directory for review data and scores |

## How scoring works

After a review, you can grade each model's output (1-10 scale) via the **Grade** tab or by asking Claude Code to grade automatically. Scores accumulate in a leaderboard with sparkline trends, helping you decide which models to keep in your review fleet.

### Data files

Stored in `~/.config/fleet-review/` (configurable):

| File | Purpose |
| ---- | ------- |
| `reviews.json` | Review records with model outputs |
| `scores.json` | Grading entries (model, score, feedback, graded-by) |
| `last-review.json` | Written by extension for Claude Code to read |
| `pending-scores.json` | Written by Claude Code, auto-imported by extension |

## Architecture

- **No APIs** — all AI calls go through locally installed CLIs via `child_process.spawn()`
- **Sidebar-first UI** — main workflow lives in the Activity Bar
- **JSON file storage** — no database, no server
- **Parallel dispatch** via `Promise.allSettled()` with per-model timeout + extend/kill controls

## Shell script

The `shell/` directory contains the original standalone bash script (`fleet-review`) that predates this extension. It works independently and can be installed via `make install` in that directory.

## License

MIT
