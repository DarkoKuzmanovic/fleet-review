# Todo

## Suggested improvements

### Bugs & polish

- ~~**GLM output not streaming to UI** — `httpDispatch` is non-streaming (single POST → wait for full response), so `onBytes` / `onText` only fire once at the end. Other CLI models stream via `spawn` stdout, so their byte counters and chunk previews update live. Fix: switch GLM to `stream: true` and parse SSE chunks, firing `onText`/`onBytes` incrementally as each SSE event arrives.~~ ✅ Done in 0.3.0
- ~~**Clock resets chunk preview during streaming** — when stdout is actively streaming (KB-scale output), the elapsed timer's `tickElapsed` call rewrites the `.elapsed` element text which clears the chunk preview until the next chunk arrives. The elapsed time and the chunk preview share the same rendering path in `updateBytes`. Fix: render elapsed time and byte count in separate DOM elements so they update independently — the clock tick won't touch the chunk preview buffer.~~ ✅ Done in 0.3.0
- ~~**Extend timeout progress ring needs visual distinction** — after a model hits its timeout and the user extends it, the progress ring just continues from where it was (full circle, amber → red). There's no visual indicator that this is an _extended_ run. Fix: once a timeout is extended, overlay the progress ring with a darker red tint (e.g., a second conic-gradient layer or a CSS border/pulse animation on the ring) so the user can see at a glance "this model is on borrowed time."~~ ✅ Done in 0.3.0
- ~~**Horizontal scrollbar in history list** — the `.history-list` container overflows horizontally on longer PR titles. Fix: add `overflow-x: hidden` (or `min-width: 0` on the flex container) to the history list, and consider truncating the title with `text-overflow: ellipsis` + `overflow: hidden` on the `.history-pr` span instead of the current `substring(0, 40)` which is brittle.~~ ✅ Done in 0.3.0

### UX improvements

- ~~**Collapsible output with copy button** — result blocks (`<pre>` elements in `.result-block`) show the full review output inline with no easy way to collapse or copy. Fix: wrap each output `<pre>` in a `<details>`-like collapsible container (already using `<details>` for the summary line, but the inner `<pre>` should be independently collapsible for long outputs). Add a small, subtle copy button (clipboard icon) that appears on hover in the upper-right corner of the output area. Uses `navigator.clipboard.writeText()` — VS Code webview context supports this.~~ ✅ Done in 0.3.0
- ~~**In-extension Claude Code grading prompt** — instead of using a VS Code notification ("Ask Claude Code to grade…") which disappears and is easy to lose, render a copy-able prompt block at the bottom of the Review sidebar (or Grade tab) when a review is complete. The prompt should include the exact instructions for Claude Code (read `last-review.json`, grade models 1–10, write `pending-scores.json`) plus a one-click copy button. This keeps the grading workflow entirely within the extension UI — no notification hunting.~~ ✅ Done in 0.3.0

### New features

- ~~**Review comparison view** — after a review completes, add a side-by-side or tabbed comparison of all model outputs. Surface unique findings per model (findings mentioned by only one model) and consensus issues (flagged by 2+). Helps answer "which model caught something the others missed?" Tie into the scoring system by showing each model's historical avg score next to its output.~~ ✅ Done in 0.3.0
- ~~**Review diff annotations** — instead of just posting model outputs as GitHub comments, parse model output for file:line references (most models cite specific lines) and create inline PR review comments at those positions. Gives the fleet review GitHub-native integration rather than wall-of-text comments.~~ ✅ Done in 0.3.0
- ~~**Model cost tracking** — for API-based models (GLM via Nano-GPT), track token usage and approximate cost per review. Display in the summary card alongside duration and output size. Helps users answer "is this model worth the price?"~~ ✅ Done in 0.3.0
- ~~**Configurable review prompts per project type** — `PromptBuilder` already detects project type (android, jvm, node, rust, go, python, ruby) but uses the same audit prompt for all. Allow users to customize or swap prompts per project type via settings, so a Rust PR gets a prompt focused on memory safety, ownership, and unsafe blocks, while a Node PR focuses on async/error handling.~~ ✅ Done in 0.3.0

## Rename candidates

### Quirky / playful

| #   | Name         | Why                                          |
| --- | ------------ | -------------------------------------------- |
| 1   | Code Jury    | A panel of AIs deliberating your PR          |
| 2   | Hydra        | Many heads, one verdict                      |
| 3   | Audit Royale | Battle royale but for code review            |
| 4   | Thunderdome  | Five models enter, one merged report leaves  |
| 5   | Mob Review   | Like mob programming, but AI reviewers       |
| 6   | Dogpile      | Everyone jumping on the PR at once           |
| 7   | Firing Squad | Brutal but memorable for code audits         |
| 8   | Gauntlet     | Your PR runs through a gauntlet of reviewers |
| 9   | Colosseum    | Models compete, scores decide the champion   |
| 10  | Stampede     | A herd of AIs charging at your diff          |

### Descriptive but not generic

| #   | Name       | Why                                                 |
| --- | ---------- | --------------------------------------------------- |
| 1   | Multipass  | Multiple passes over code (and a Fifth Element nod) |
| 2   | Crossfire  | Cross-referencing reviews from multiple sources     |
| 3   | Quorum     | Enough reviewers to reach consensus                 |
| 4   | Ensemble   | Ensemble methods — multiple models, one answer      |
| 5   | Roundtable | Multiple reviewers at the table                     |
| 6   | Broadside  | Full volley from all cannons at once                |
| 7   | Parallax   | Same code, different perspectives                   |
| 8   | Chorus     | Many voices, one song                               |
| 9   | Dispatch   | Dispatching reviews to multiple CLIs                |
| 10  | Confluence | Where multiple review streams merge                 |

### Genuinely good (brandable, short, professional)

| #   | Name     | Why                                                         |
| --- | -------- | ----------------------------------------------------------- |
| 1   | Phalanx  | Organized formation — multiple units, unified front         |
| 2   | Volley   | Simultaneous fire, parallel dispatch                        |
| 3   | Prism    | Code goes in, splits into a spectrum of reviews, recombines |
| 4   | Manifold | Multiple inputs, single output — also an engineering term   |
| 5   | Canopy   | Full coverage from above                                    |
| 6   | Lattice  | Structured interconnection of reviewers                     |
| 7   | Meridian | Convergence point for multiple lines                        |
| 8   | Sentry   | Watchful, protective, short                                 |
| 9   | Apex     | The top — where the best model earns its place              |
| 10  | Convoy   | Moving together toward the same goal                        |

Favorites: Phalanx, Prism, Code Jury
