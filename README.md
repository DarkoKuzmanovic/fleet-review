# fleet-review

Multi-AI code review for GitHub PRs. Fans out your PR to multiple AI reviewers in parallel, posts individual audits as PR comments, then synthesizes a merged report ranked by consensus.

## How it works

```
PR Diff ──┬──► Claude  ──┐
          ├──► Codex   ──┤
          ├──► Qwen    ──┼──► Merged Report (deduplicated, ranked by consensus)
          └──► Copilot ──┘
```

Each AI independently reviews the diff and posts findings as a PR comment. Then Claude synthesizes all findings into a single prioritized report — deduplicating issues, ranking by how many AIs agree, and filtering noise.

## Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated
- At least one AI CLI installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Qwen CLI](https://github.com/QwenLM/qwen-code) (`qwen`)
  - [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli) (`copilot`)

## Install

```bash
git clone https://github.com/DarkoKuzmanovic/fleet-review.git
cd fleet-review
make install
```

This installs to `~/.local/bin/`. For system-wide install:

```bash
sudo make install PREFIX=/usr/local
```

To uninstall:

```bash
make uninstall
```

## Usage

```bash
# Review a PR (auto-detects repo from git remote)
fleet-review 42

# Review by full URL
fleet-review https://github.com/owner/repo/pull/123

# Pick specific auditors
fleet-review 42 --only claude,codex

# Run audits only (no merge step)
fleet-review 42 --skip-merge

# Re-synthesize existing audit comments
fleet-review 42 --merge-only

# Use a custom audit prompt
fleet-review 42 --prompt my-prompt.md

# Specify repo explicitly
fleet-review 42 --repo owner/repo
```

## Environment auto-detection

`fleet-review` detects whether you're running from VS Code or a plain terminal and adjusts which AI CLIs it calls:

| Environment | Auditors | Why |
|---|---|---|
| VS Code terminal | claude, qwen | Copilot + Codex already auto-review via GitHub Apps |
| Plain terminal | claude, codex, qwen | Copilot auto-reviews via GitHub, but Codex doesn't |

Use `--only` to override auto-detection.

## What gets posted to your PR

1. One comment per auditor: `## Audit by claude`, `## Audit by codex`, etc.
2. A final `## Merged Audit Report` with:
   - **Action items** ranked by consensus (3/4 AIs agree = top priority)
   - **Dismissed findings** with rationale
   - **Consensus summary table**

## Custom audit prompts

Create a markdown file with your review criteria and pass it with `--prompt`:

```bash
fleet-review 42 --prompt security-audit.md
```

The prompt receives the PR title, description, and full diff appended automatically.

## Project type detection

The tool auto-detects your project type and includes it in the prompt context:

- Android (Kotlin/Java, Gradle)
- JVM (Kotlin/Java, Gradle)
- Node.js/TypeScript
- Rust
- Go
- Python
- Ruby

## License

MIT
