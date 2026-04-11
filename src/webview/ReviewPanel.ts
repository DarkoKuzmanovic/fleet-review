import * as vscode from "vscode";

import { ExtensionMessage, ModelName, MODEL_NAMES, PR, ReviewRecord, WebviewMessage } from "../types";
import { Config } from "../config";
import { GitHubClient } from "../github/GitHubClient";
import { CliDispatcher } from "../review/CliDispatcher";
import { PromptBuilder } from "../review/PromptBuilder";
import { ReviewOrchestrator } from "../review/ReviewOrchestrator";
import { ScoreStore } from "../scoring/ScoreStore";
import { ESCAPE_HTML_JS } from "./webviewUtils";

export class ReviewPanel {
  public static current: ReviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly orchestrator: ReviewOrchestrator;
  private readonly promptBuilder: PromptBuilder;
  private readonly github: GitHubClient;
  private readonly store: ScoreStore;
  private repo: string = "";
  private disposables: vscode.Disposable[] = [];

  static create(extensionUri: vscode.Uri, github: GitHubClient, store: ScoreStore): ReviewPanel {
    if (ReviewPanel.current) {
      ReviewPanel.current.panel.reveal();
      return ReviewPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("fleetReview.review", "Fleet Review", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "assets")],
    });
    return new ReviewPanel(panel, extensionUri, github, store);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private extensionUri: vscode.Uri,
    github: GitHubClient,
    store: ScoreStore,
  ) {
    this.panel = panel;
    this.github = github;
    this.store = store;
    this.promptBuilder = new PromptBuilder();
    this.orchestrator = new ReviewOrchestrator(github, new CliDispatcher(), this.promptBuilder, store);

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    ReviewPanel.current = this;
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "requestPRs":
        await this.fetchPRs();
        break;
      case "startReview":
        await this.startReview(msg.models, msg.prNumber);
        break;
      case "cancelReview":
        this.orchestrator.cancel();
        break;
      case "gradeWithClaude":
        await this.gradeWithClaude();
        break;
      case "openGradePanel":
        await vscode.commands.executeCommand("fleetReview.gradeReview");
        break;
    }
  }

  private async fetchPRs(): Promise<void> {
    try {
      this.repo = await this.github.detectRepo();
      const prs = await this.github.listPRs(this.repo);
      this.post({ type: "prs", prs });
    } catch (err) {
      this.post({
        type: "error",
        message: `Failed to fetch PRs: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  private async startReview(models: ModelName[], prNumber: number): Promise<void> {
    try {
      const [pr, diff] = await Promise.all([
        this.github.getPRInfo(this.repo, prNumber),
        this.github.getPRDiff(this.repo, prNumber),
      ]);

      const projectType = Config.workspaceRoot ? this.promptBuilder.detectProjectType(Config.workspaceRoot) : "unknown";

      const review = await this.orchestrator.runReview(this.repo, pr, diff, models, projectType, (model, status) => {
        this.post({ type: "reviewProgress", model, status });
      });

      this.post({ type: "reviewComplete", review });

      const successCount = Object.values(review.results).filter((r) => r.success).length;
      vscode.window.showInformationMessage(
        `Fleet Review: ${successCount}/${models.length} models completed for PR #${prNumber}`,
      );
    } catch (err) {
      this.post({
        type: "reviewError",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async gradeWithClaude(): Promise<void> {
    try {
      const review = this.store.getLatestReview();
      if (!review) {
        vscode.window.showWarningMessage("Fleet Review: No review to grade");
        return;
      }

      this.store.writeLastReview(review);
      vscode.window.showInformationMessage(
        `Fleet Review: Review data written to ${this.store.lastReviewPath}. ` +
          "Open Claude Code and ask it to grade the review and write scores to " +
          this.store.pendingScoresPath,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Fleet Review: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private post(msg: ExtensionMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    ReviewPanel.current = undefined;
    this.orchestrator.cancel();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private getHtml(): string {
    const modelsJson = JSON.stringify([...MODEL_NAMES]);
    const defaultsJson = JSON.stringify(Config.defaultModels);

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
    color: var(--desc-fg); margin-bottom: 12px;
  }
  h3 { font-size: 14px; margin-bottom: 8px; }

  .section { margin-bottom: 24px; }
  .hidden { display: none !important; }

  select, input[type="text"] {
    width: 100%; padding: 6px 8px; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px; font-size: 13px;
    font-family: var(--vscode-font-family); outline: none;
  }
  select:focus, input[type="text"]:focus { border-color: var(--focus-border); }

  button {
    padding: 8px 16px; background: var(--btn-bg); color: var(--btn-fg);
    border: none; border-radius: 4px; cursor: pointer; font-size: 13px;
    font-family: var(--vscode-font-family); transition: opacity 0.1s;
  }
  button:hover { background: var(--btn-hover); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none;
  }

  .checkbox-group { display: flex; flex-direction: column; gap: 0; margin: 8px 0; }
  .checkbox-group label {
    display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;
    padding: 6px 8px; border-radius: 4px; margin: 0 -8px; transition: background 0.1s;
  }
  .checkbox-group label:hover { background: var(--list-hover); }
  .checkbox-group input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--btn-bg); flex-shrink: 0; }

  .model-row {
    display: flex; align-items: center; gap: 10px; padding: 8px 8px;
    margin: 0 -8px; border-radius: 4px; font-size: 13px; transition: background 0.1s;
  }
  .model-row:hover { background: var(--list-hover); }
  .model-row + .model-row { border-top: 1px solid var(--border); }
  .model-row .name { flex: 1; font-weight: 500; }
  .badge {
    padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; letter-spacing: 0.2px;
  }
  .badge.pending { background: rgba(255,255,255,0.06); color: var(--desc-fg); }
  .badge.running { background: var(--vscode-progressBar-background); color: #fff; }
  .badge.done { background: var(--vscode-testing-iconPassed); color: #fff; }
  .badge.failed, .badge.timeout { background: var(--vscode-testing-iconFailed); color: #fff; }

  .results-section { margin-top: 16px; }
  .result-block { margin-bottom: 4px; }
  .result-block summary {
    cursor: pointer; font-weight: 500; font-size: 13px; padding: 8px 8px;
    margin: 0 -8px; border-radius: 4px; transition: background 0.1s; list-style: none;
  }
  .result-block summary::-webkit-details-marker { display: none; }
  .result-block summary::before {
    content: '\\25B6'; display: inline-block; width: 16px; font-size: 9px;
    transition: transform 0.15s; color: var(--desc-fg);
  }
  .result-block details[open] summary::before, details[open] > summary::before { transform: rotate(90deg); }
  .result-block summary:hover { background: var(--list-hover); }
  .result-block pre {
    background: var(--input-bg); padding: 12px; border-radius: 4px;
    overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap;
    margin-top: 4px; border: 1px solid var(--border);
  }

  .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  .error { color: var(--vscode-errorForeground); font-size: 13px; margin: 8px 0; }
  .pr-meta { font-size: 12px; color: var(--desc-fg); margin-left: 4px; }
</style>
</head>
<body>

<!-- State 1: PR Select -->
<div id="state-select" class="section">
  <h2>Select Pull Request</h2>
  <select id="pr-select" disabled>
    <option>Loading PRs...</option>
  </select>
  <div id="pr-error" class="error hidden"></div>

  <h2 style="margin-top:16px">Select Models</h2>
  <div id="model-checkboxes" class="checkbox-group"></div>

  <div class="actions">
    <button id="btn-start" disabled>Start Review</button>
    <button id="btn-refresh" class="secondary">Refresh PRs</button>
  </div>
</div>

<!-- State 2: Progress -->
<div id="state-progress" class="section hidden">
  <h2>Review in Progress</h2>
  <div id="progress-models"></div>
  <div class="actions">
    <button id="btn-cancel" class="secondary">Cancel</button>
  </div>
</div>

<!-- State 3: Results -->
<div id="state-results" class="section hidden">
  <h2>Review Results</h2>
  <div id="results-summary"></div>
  <div id="results-detail" class="results-section"></div>
  <div class="actions">
    <button id="btn-grade-manual">Grade Manually</button>
    <button id="btn-grade-claude">Grade with Claude Code</button>
    <button id="btn-new-review" class="secondary">New Review</button>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const ALL_MODELS = ${modelsJson};
  const DEFAULT_MODELS = ${defaultsJson};

  let prs = [];
  let currentReview = null;
  let prLoadTimer = null;

  // --- Init ---
  function init() {
    buildModelCheckboxes();
    requestPRs();

    document.getElementById('btn-start').onclick = startReview;
    document.getElementById('btn-refresh').onclick = requestPRs;
    document.getElementById('btn-cancel').onclick = () => vscode.postMessage({ type: 'cancelReview' });
    document.getElementById('btn-grade-manual').onclick = () => {
      vscode.postMessage({ type: 'openGradePanel' });
    };
    document.getElementById('btn-grade-claude').onclick = () => vscode.postMessage({ type: 'gradeWithClaude' });
    document.getElementById('btn-new-review').onclick = resetToSelect;
  }

  function clearPrLoadTimer() {
    if (prLoadTimer !== null) {
      clearTimeout(prLoadTimer);
      prLoadTimer = null;
    }
  }

  function showPrError(message, optionLabel) {
    clearPrLoadTimer();
    const sel = document.getElementById('pr-select');
    sel.disabled = false;
    sel.innerHTML = '<option disabled>' + optionLabel + '</option>';
    document.getElementById('btn-start').disabled = true;
    document.getElementById('pr-error').textContent = message;
    document.getElementById('pr-error').classList.remove('hidden');
  }

  function requestPRs() {
    clearPrLoadTimer();
    const sel = document.getElementById('pr-select');
    sel.disabled = true;
    sel.innerHTML = '<option>Loading PRs...</option>';
    document.getElementById('btn-start').disabled = true;
    document.getElementById('pr-error').classList.add('hidden');

    prLoadTimer = setTimeout(() => {
      showPrError(
        'Timed out while loading PRs. Check Output > Fleet Review for gh logs.',
        'PR load timed out',
      );
    }, 10000);

    vscode.postMessage({ type: 'requestPRs' });
  }

  function buildModelCheckboxes() {
    const container = document.getElementById('model-checkboxes');
    container.innerHTML = ALL_MODELS.map(m =>
      '<label><input type="checkbox" value="' + m + '"' +
      (DEFAULT_MODELS.includes(m) ? ' checked' : '') +
      '> ' + m + '</label>'
    ).join('');
  }

  function getSelectedModels() {
    return Array.from(document.querySelectorAll('#model-checkboxes input:checked'))
      .map(cb => cb.value);
  }

  function getSelectedPR() {
    const sel = document.getElementById('pr-select');
    return parseInt(sel.value, 10);
  }

  // --- State transitions ---
  function showState(name) {
    ['select', 'progress', 'results'].forEach(s => {
      document.getElementById('state-' + s).classList.toggle('hidden', s !== name);
    });
  }

  function resetToSelect() {
    currentReview = null;
    showState('select');
  }

  // --- Actions ---
  function startReview() {
    const models = getSelectedModels();
    const prNumber = getSelectedPR();
    if (!models.length || isNaN(prNumber)) return;

    showState('progress');
    const container = document.getElementById('progress-models');
    container.innerHTML = models.map(m =>
      '<div class="model-row" id="progress-' + m + '">' +
      '  <span class="name">' + m + '</span>' +
      '  <span class="badge pending">pending</span>' +
      '</div>'
    ).join('');

    vscode.postMessage({ type: 'startReview', models, prNumber });
  }

  // --- Message handler ---
  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
      case 'prs':
        prs = msg.prs;
        renderPRs();
        break;
      case 'reviewProgress':
        updateProgress(msg.model, msg.status);
        break;
      case 'reviewComplete':
        currentReview = msg.review;
        renderResults(msg.review);
        break;
      case 'reviewError':
        showState('select');
        document.getElementById('pr-error').textContent = msg.error;
        document.getElementById('pr-error').classList.remove('hidden');
        break;
      case 'error':
        showPrError(msg.message, 'Failed to load PRs');
        break;
    }
  });

  function renderPRs() {
    clearPrLoadTimer();
    const sel = document.getElementById('pr-select');
    sel.disabled = false;
    document.getElementById('btn-start').disabled = false;
    document.getElementById('pr-error').classList.add('hidden');

    if (prs.length === 0) {
      sel.innerHTML = '<option disabled>No open PRs in this repo</option>';
      document.getElementById('btn-start').disabled = true;
      return;
    }

    sel.innerHTML = prs.map(pr =>
      '<option value="' + pr.number + '">#' + pr.number + ' — ' +
      escapeHtml(pr.title) + ' <span class="pr-meta">(' + pr.author +
      ', +' + pr.additions + '/-' + pr.deletions + ')</span></option>'
    ).join('');
  }

  function updateProgress(model, status) {
    const row = document.getElementById('progress-' + model);
    if (!row) return;
    const badge = row.querySelector('.badge');
    badge.className = 'badge ' + status;
    badge.textContent = status;
  }

  function renderResults(review) {
    showState('results');
    const models = Object.keys(review.results);
    const successful = models.filter(m => review.results[m].success);
    const failed = models.filter(m => !review.results[m].success);

    document.getElementById('results-summary').innerHTML =
      '<p>' + successful.length + '/' + models.length + ' models completed for PR #' + review.prNumber + '</p>' +
      (failed.length ? '<p class="error">Failed: ' + failed.join(', ') + '</p>' : '');

    document.getElementById('results-detail').innerHTML = models.map(m => {
      const r = review.results[m];
      return '<details class="result-block"' + (r.success ? ' open' : '') + '>' +
        '<summary>' + m + (r.success ? ' ✓' : ' ✗') +
        (r.postedToGitHub ? ' (posted to GitHub)' : '') +
        ' — ' + (r.durationMs / 1000).toFixed(1) + 's</summary>' +
        (r.success
          ? '<pre>' + escapeHtml(r.output) + '</pre>'
          : '<p class="error">' + escapeHtml(r.error || 'Unknown error') + '</p>') +
        '</details>';
    }).join('');
  }

  ${ESCAPE_HTML_JS}

  if (document.readyState === 'complete') {
    setTimeout(init, 0);
  } else {
    window.addEventListener('load', init);
  }
</script>
</body>
</html>`;
  }
}
