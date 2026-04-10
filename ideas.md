# Fleet Review UI and UX Ideas

## Ideas we like (expanded)

### 4. Show Streamed First Findings

Instead of waiting for full model completion, show first finding snippets as they arrive.

The plumbing is mostly there. `reviewBytes` already streams byte counts from `CliDispatcher` through the orchestrator to the webview. The change is forwarding partial text, not just counts.

Raw streaming looks messy — LLM output arrives mid-sentence with markdown fragments. Two better approaches:

- **First finding extraction:** Buffer chunks, detect the first complete heading or section (most audit outputs start with `## Critical` or similar), send just that as a `firstFinding` message. Gives the "something is happening" signal without noise.
- **Rolling tail preview:** Show the last 3 lines of output in a muted `<pre>` block under each model row. Auto-collapses when the model finishes. Less parsing, still useful.

The UI work is the real challenge — making partial output readable rather than jarring. Consider a subtle fade-in on new lines and a max-height with overflow hidden so the preview doesn't push other rows around.

Complexity: Medium. Backend plumbing exists, frontend polish is the work.

### 5. One-click Retry for Failed Models

Per-row Retry button that re-dispatches a single model without rerunning everything.

`ReviewOrchestrator.runReview` currently dispatches all models as a batch and returns one `ReviewRecord`. Retry needs a lighter path — call `dispatcher.dispatch(model, prompt)` for one model and patch the result into the existing record.

Key implementation details:

- **Stash the prompt:** The prompt and diff are currently scoped inside `runReview` and garbage collected. Simplest fix: save `lastPrompt` and `lastDiff` on the orchestrator instance.
- **New message type:** `retryModel` from webview, triggers a single dispatch, sends progress updates using the existing `reviewProgress` flow, then sends an updated `reviewComplete`.
- **UI:** After `reviewComplete`, failed/timeout rows get a Retry button via `document.createElement` (no inline onclick — template literal escaping rule). When retry succeeds, replace that row's content in place.
- **Retry All Failed** button is worth adding too, for when 2-3 models time out together.

Complexity: Low-medium. Dispatch machinery exists. Main work is `retrySingleModel` on the orchestrator and the message wiring.

### 12. Review Summary Card

A compact card at the top of results that surfaces key stats at a glance.

All data already exists in `ReviewRecord` — `results[model].success`, `durationMs`, `postedToGitHub`. No backend changes needed.

What to show:

```text
┌──────────────────────────────────────┐
│  4/5 done   |  12.3s avg  |  3 posted│
│  1 timeout  |  claude 8s  |  to GH   │
└──────────────────────────────────────┘
```

- Completion: X/Y done, list failures
- Timing: average, fastest model, slowest model
- GitHub: how many comments were posted
- Output volume: total KB of review output

Skip "consensus risks" for now — that requires parsing LLM output and cross-referencing findings. Keep the card purely data-driven from `ReviewRecord` fields. Consider making it sticky so it stays visible when scrolling through individual results.

Complexity: Low. Pure frontend, all data available.

### 14. Empty and Loading Skeleton States

Replace static "Loading..." text with skeleton placeholders that match the shape of real content.

Current state is text-only with sudden content swaps:

- PR list: disabled `<select>` with "Loading PRs..."
- Progress rows: jump from "pending" to "running"
- Scores: plain "No scores yet."
- Grade: plain "Run a review first..."

What to replace with:

- **PR dropdown loading:** 3-4 pulsing gray bars matching the height of PR option rows. Fade in real options on arrival.

- **Model progress initial:** Skeleton rows for each selected model — gray name placeholder, gray badge. Morph into real rows as `reviewProgress` messages arrive.
- **Scores tab first load:** 4-5 skeleton table rows before leaderboard data arrives.
- **Results transition:** Brief skeleton for the summary card while `reviewComplete` processes.

CSS-only implementation works well. A single `.skeleton` class with shimmer animation using `linear-gradient` and `background-position` keyframes. Match skeleton dimensions to actual content to avoid layout shift.

Note: VS Code's own UI uses subtle opacity transitions more than full skeletons. A pulsing opacity on existing empty-state text might feel more native. Worth testing both approaches.

Complexity: Low. CSS + minor HTML. No backend work.

---

## More ideas

### A. Timeout Progress Ring

Replace the flat "running" badge with a small circular arc that fills based on elapsed time vs the model's timeout limit. When a model is at 80% of its timeout, the ring turns amber. At 100% it turns red and the Extend/Kill buttons appear.

This gives an at-a-glance sense of urgency without needing to read elapsed time numbers. The data is already there — `modelStartTimes` tracks start time, `MODEL_TIMEOUTS` has the limit per model. Pure CSS `conic-gradient` on a small `<span>`, updated by the existing `tickElapsed` interval.

### B. Diff Size Gate

Before starting a review, check the PR's `additions + deletions` count and warn if it exceeds a threshold (say 1500 lines). Large diffs cause timeouts, truncation, and worse review quality.

The data is already in the `PR` type (`additions`, `deletions`) and rendered in the dropdown. The gate would be a small warning banner between the PR selector and the Start button: "This PR has 2,400 changed lines. Reviews may be slower or truncated. Consider reviewing individual commits instead."

Could also auto-suggest selecting fewer models for large diffs.

### C. Model Health Check on Load

Show a small green/red dot next to each model checkbox indicating whether the CLI is installed and reachable. Run a quick `which claude`, `which codex`, etc. on sidebar init.

Currently users discover a missing CLI only after a review fails. A 50ms `which` check per model on load would surface this immediately. Gray dot = unchecked, green = found, red = not found. Tooltip shows the resolved path or "not installed".

### D. Review History Drawer

There's no way to revisit past reviews from the sidebar. Add a small "History" section or dropdown at the bottom of the Review tab that loads previous `ReviewRecord` entries from `reviews.json`.

Clicking a past review re-renders the results view with that record's data. This makes the Grade and Scores tabs more useful — you can go back and grade a review you skipped earlier.

The `ScoreStore` already has `getLatestReview()`, extending it to return the last N reviews is trivial.

### E. Inline Output Word Count and Reading Time

After results render, show a small "~450 words, 2 min read" label under each model's output block. Helps users decide which model output to read first when triaging — a 200-word output is a quick scan, a 1,500-word output needs dedicated time.

Trivial to compute from the output string. Useful signal when comparing verbose vs concise models.

### F. Smart Model Defaults from History

After enough grading data accumulates, auto-suggest the top N models by average score as the default selection. Currently defaults are static in settings. A "Suggested" chip next to the top performers in the checkbox list, based on `ScoreStore.getModelStats`, would nudge users toward their best-performing models without forcing it.

---

## Implementation order

### Batch 1 — Visual polish (no backend changes)

1. Skeleton states (14)
2. Summary card (12)
3. Timeout progress ring (A)

### Batch 2 — Functional improvements

1. Retry failed model (5)
2. Diff size gate (B)
3. Model health check (C)

### Batch 3 — Deeper features

1. Streamed first findings (4)
2. Review history drawer (D)
3. Smart model defaults (F)
