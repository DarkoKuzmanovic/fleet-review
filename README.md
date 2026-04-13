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
| [Codex CLI](https://github.com/openai/codex) | `npm i -g @openai/codex` | |
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
| `Fleet Review: Set Gateway API Key` | Stores an HTTP gateway API key in VS Code SecretStorage |

## Configuration

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `fleetReview.defaultModels` | `["claude", "gemini", "qwen"]` | Models pre-checked in the review panel. Any registered provider name is valid. |
| `fleetReview.timeoutSeconds` | `300` | Default timeout per model (seconds). Individual providers can override via their own `timeoutSeconds`. |
| `fleetReview.customProviders` | `[]` | User-registered CLI or HTTP model providers. Each entry declares a `kind` (`cli` or `http`) plus the command/gateway details — see [Custom providers](#custom-providers). |
| `fleetReview.customGateways` | `[]` | User-defined OpenAI-compatible HTTP gateways (name + baseUrl + optional headers). API keys are stored separately via the `Set Gateway API Key` command. |
| `fleetReview.diffSizeWarningThreshold` | `1500` | Warn before reviewing PRs with more changed lines than this |
| `fleetReview.projectPrompts` | `{}` | Custom review prompts per project type — overrides default audit instructions while preserving the output format |
| `fleetReview.projectHints` | `{}` | Extra hints appended per project type without replacing the full prompt |
| `fleetReview.dataDir` | `~/.config/fleet-review` | Directory for review data and scores |

### Custom providers

Fleet Review ships with six built-in providers: `claude`, `codex`, `gemini`, `qwen`, `copilot` (CLI-based) and `glm` (HTTP, via the Nano-GPT gateway). To add more models without editing code, register entries in `fleetReview.customProviders`. HTTP providers point at a gateway in `fleetReview.customGateways` or at one of the built-in gateways (`nanogpt`, `openrouter`).

Example — adding another Nano-GPT model:

```jsonc
{
  "fleetReview.customProviders": [
    {
      "name": "minimax",
      "displayName": "MiniMax",
      "kind": "http",
      "gateway": "nanogpt",
      "modelId": "minimax/minimax-m2.7"
    }
  ]
}
```

Then run `Fleet Review: Set Gateway API Key`, pick `nanogpt`, and paste your key. The new model shows up in the sidebar checkboxes and participates in merge reports. The key is stored in VS Code SecretStorage; `FLEET_REVIEW_NANOGPT_API_KEY` in the environment works as a fallback.

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

- **Pluggable providers** — CLI models spawn local binaries via `child_process.spawn()`; HTTP models call OpenAI-compatible gateways (Nano-GPT, OpenRouter). Both route through a single `ProviderRegistry`.
- **Sidebar-first UI** — main workflow lives in the Activity Bar
- **JSON file storage** — no database, no server
- **Parallel dispatch** via `Promise.allSettled()` with per-model timeout + extend/kill controls
- **Gateway API keys in SecretStorage** — never written to `settings.json`; set via `Fleet Review: Set Gateway API Key`

## Shell script

The `shell/` directory contains the original standalone bash script (`fleet-review`) that predates this extension. It works independently and can be installed via `make install` in that directory.

## License

MIT
