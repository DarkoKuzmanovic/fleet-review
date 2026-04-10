# Potential Roadmap: v0.5 and v0.6

Ideas for future development after the v0.3–v0.4 bug fixes and cleanup are done.

---

## v0.5 — Make It Smarter

The v0.3–v0.4 cycle fixes bugs and pays off debt. v0.5 is where the tool starts doing more with what it already has.

### Pluggable Models

Adding a new AI model today means editing 5+ files. Instead, define a simple `ModelProvider` interface (CLI-based or HTTP-based) and let users register new models through settings. The GLM HTTP model already proves the pattern — it works differently from the CLI models but gets shoehorned into the same dispatcher.

### Weighted Merge Reports

The merge synthesis currently treats all models equally. But if Claude consistently scores 8+ and Codex averages 5, Claude's findings should carry more weight. The scoring history is already there in `scores.json` — feed it into the merge prompt so higher-rated models influence the final report more.

### Cross-Review Comparison

Every review is saved to `reviews.json`, but there's no way to compare them. Useful questions like "what did Gemini catch that nobody else did?" or "how do this PR's findings compare to last week's?" are answerable with the data — just needs a UI.

### Cost Awareness

GLM already reports token usage. For CLI models, output size is a rough proxy. Over time this lets you compare value: "Gemini scores 7.8 and costs $0.03 per review, Claude scores 8.1 at $0.12." Helps pick the right model mix.

### Inline Editor Annotations

Right now all findings go to GitHub as PR comments. Showing them as squiggly underlines or CodeLens hints directly in the editor would make Fleet Review useful for pre-push reviews too — before you even open a PR.

---

## v0.6 — Break Out of VS Code

The interesting parts of Fleet Review (dispatching to multiple AIs, building consensus, tracking quality) have nothing to do with VS Code. They're pure TypeScript. v0.6 extracts that core so it can run anywhere.

### Standalone Core Package

Pull `review/`, `scoring/`, and `github/` into a `@fleet-review/core` library. The VS Code extension becomes a thin UI layer on top. This is mostly moving files and drawing a clean boundary — no new features, just structure.

### Proper CLI Tool

The `shell/fleet-review` bash script works but can't do scoring, merge reports, or history. A Node CLI built on the core package replaces it with full feature parity:

```
fleet-review run --models claude,gemini --pr 42
fleet-review scores --timeframe month
fleet-review merge --review <id>
```

Works in any terminal, no VS Code required.

### GitHub Action

A thin wrapper around the core that runs on every PR automatically. Three models review in parallel, a merged report gets posted, done. This is where multi-model review makes the most sense — no human has to remember to trigger it.

### Review Policies

Once it runs in CI, you want guardrails. Simple rules like:

- "Block merge if 2+ models flag a critical finding"
- "Auto-approve if all models agree the PR is clean and the diff is small"
- "Require human review if models disagree on severity"

The consensus mechanism and scoring history provide real signal to gate merges on — not just one AI's opinion, but agreement across multiple models.
