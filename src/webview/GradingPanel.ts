import * as vscode from 'vscode';

import { ExtensionMessage, ReviewRecord, ScoreEntry, WebviewMessage } from '../types';
import { ScoreStore } from '../scoring/ScoreStore';

export class GradingPanel {
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static create(
    extensionUri: vscode.Uri,
    store: ScoreStore,
    review?: ReviewRecord
  ): GradingPanel {
    let target: ReviewRecord | undefined;
    try {
      target = review ?? store.getLatestReview();
    } catch (err) {
      vscode.window.showErrorMessage(`Fleet Review: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    if (!target) {
      vscode.window.showWarningMessage('Fleet Review: No review to grade');
      throw new Error('No review to grade');
    }

    const panel = vscode.window.createWebviewPanel(
      'fleetReview.grading',
      `Grade: PR #${target.prNumber}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    return new GradingPanel(panel, store, target);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private store: ScoreStore,
    private review: ReviewRecord
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    if (msg.type === 'submitGrades') {
      try {
        const entries: ScoreEntry[] = msg.scores.map((s) => ({
          reviewId: this.review.id,
          model: s.model,
          score: s.score,
          feedback: s.feedback,
          gradedBy: 'user' as const,
          timestamp: new Date().toISOString(),
        }));

        await this.store.saveScores(entries);

        vscode.window.showInformationMessage(
          `Fleet Review: Grades saved for ${entries.length} models`
        );

        const response: ExtensionMessage = { type: 'gradesImported', scores: entries };
        this.panel.webview.postMessage(response);
      } catch (err) {
        vscode.window.showErrorMessage(`Fleet Review: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private getHtml(): string {
    const models = Object.entries(this.review.results)
      .filter(([, r]) => r.success)
      .map(([model, r]) => ({ model, output: r.output, durationMs: r.durationMs }));

    const modelsJson = JSON.stringify(models);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, rgba(255,255,255,0.07));
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, transparent);
    --desc-fg: var(--vscode-descriptionForeground);
    --list-hover: var(--vscode-list-hoverBackground);
    --focus-border: var(--vscode-focusBorder);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); padding: 24px; font-size: 13px; line-height: 1.4; max-width: 720px; }
  h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
    color: var(--desc-fg); margin-bottom: 16px;
  }

  .grade-card {
    border: 1px solid var(--border); border-radius: 6px; margin-bottom: 12px; padding: 16px;
    transition: border-color 0.1s;
  }
  .grade-card:hover { border-color: var(--focus-border); }
  .grade-card h3 { font-size: 14px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
  .grade-card .duration { font-size: 12px; color: var(--desc-fg); }

  details { margin-bottom: 10px; }
  details summary {
    cursor: pointer; font-size: 13px; color: var(--desc-fg); padding: 6px 8px;
    border-radius: 4px; transition: background 0.1s; list-style: none;
  }
  details summary::-webkit-details-marker { display: none; }
  details summary::before {
    content: '\\25B6'; display: inline-block; width: 16px; font-size: 9px;
    transition: transform 0.15s; color: var(--desc-fg);
  }
  details[open] summary::before { transform: rotate(90deg); }
  details summary:hover { background: var(--list-hover); }
  details pre {
    background: var(--input-bg); padding: 12px; border-radius: 4px;
    overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap;
    max-height: 300px; overflow-y: auto; margin-top: 6px; border: 1px solid var(--border);
  }

  .score-row { display: flex; align-items: center; gap: 12px; margin: 10px 0; }
  .score-row label { font-size: 13px; min-width: 50px; color: var(--desc-fg); }
  .score-row input[type="range"] { flex: 1; height: 4px; accent-color: var(--btn-bg); }
  .score-row .score-val { font-size: 18px; font-weight: 700; min-width: 28px; text-align: center; font-variant-numeric: tabular-nums; }

  textarea {
    width: 100%; height: 48px; padding: 8px 10px; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px; font-size: 13px; resize: vertical;
    font-family: var(--vscode-font-family); outline: none;
  }
  textarea:focus { border-color: var(--focus-border); }

  button {
    padding: 8px 20px; background: var(--btn-bg); color: var(--btn-fg);
    border: none; border-radius: 4px; cursor: pointer; font-size: 13px; margin-top: 12px;
    font-family: var(--vscode-font-family); transition: opacity 0.1s;
  }
  button:hover { background: var(--btn-hover); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }

  .success { color: var(--vscode-testing-iconPassed); margin-top: 12px; font-size: 13px; }
</style>
</head>
<body>
<h2>Grade PR #${this.review.prNumber}: ${escapeHtml(this.review.prTitle)}</h2>

<div id="cards"></div>
<button id="btn-submit">Submit Grades</button>
<div id="success" class="success" style="display:none"></div>

<script>
  const vscode = acquireVsCodeApi();
  const models = ${modelsJson};

  function init() {
    const container = document.getElementById('cards');
    container.innerHTML = models.map(m =>
      '<div class="grade-card" data-model="' + m.model + '">' +
      '  <h3>' + m.model + ' <span class="duration">' + (m.durationMs / 1000).toFixed(1) + 's</span></h3>' +
      '  <details>' +
      '    <summary>View audit output</summary>' +
      '    <pre>' + escapeHtml(m.output) + '</pre>' +
      '  </details>' +
      '  <div class="score-row">' +
      '    <label>Score:</label>' +
      '    <input type="range" min="1" max="10" value="5" class="score-slider" ' +
      '      oninput="this.parentElement.querySelector(\\'.score-val\\').textContent = this.value">' +
      '    <span class="score-val">5</span>' +
      '  </div>' +
      '  <textarea placeholder="Feedback (optional)..." class="feedback"></textarea>' +
      '</div>'
    ).join('');

    document.getElementById('btn-submit').onclick = submit;
  }

  function submit() {
    const scores = models.map(m => {
      const card = document.querySelector('[data-model="' + m.model + '"]');
      return {
        model: m.model,
        score: parseInt(card.querySelector('.score-slider').value, 10),
        feedback: card.querySelector('.feedback').value.trim(),
      };
    });

    vscode.postMessage({ type: 'submitGrades', scores });
    document.getElementById('btn-submit').disabled = true;
    document.getElementById('success').style.display = 'block';
    document.getElementById('success').textContent =
      'Grades saved: ' + scores.map(s => s.model + '=' + s.score).join(', ');
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  init();
</script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
