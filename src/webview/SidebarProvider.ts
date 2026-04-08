import * as vscode from "vscode";

import { ExtensionMessage, ModelName, MODEL_NAMES, TimeoutDecision, WebviewMessage } from "../types";
import { Config } from "../config";
import { GitHubClient } from "../github/GitHubClient";
import { CliDispatcher } from "../review/CliDispatcher";
import { PromptBuilder } from "../review/PromptBuilder";
import { ReviewOrchestrator } from "../review/ReviewOrchestrator";
import { ScoreStore } from "../scoring/ScoreStore";

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private orchestrator: ReviewOrchestrator;
  private repo = "";
  private pendingTimeouts = new Map<string, (decision: TimeoutDecision) => void>();

  constructor(
    private extensionUri: vscode.Uri,
    private github: GitHubClient,
    private store: ScoreStore,
    private output: vscode.OutputChannel,
  ) {
    this.orchestrator = new ReviewOrchestrator(github, new CliDispatcher(output), new PromptBuilder(), store);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.output.appendLine(`[${new Date().toISOString()}] resolveWebviewView called`);
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) =>
      this.handleMessage(msg)
    );

    webviewView.webview.html = this.getHtml();
    this.output.appendLine(`[${new Date().toISOString()}] webview HTML set`);
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    this.output.appendLine(`[${new Date().toISOString()}] Sidebar received message: ${msg.type}`);
    switch (msg.type) {
      case "requestPRs":
        await this.fetchPRs();
        break;
      case "startReview":
        await this.startReview(msg.models, msg.prNumber);
        break;
      case "cancelReview":
        this.orchestrator.cancel();
        this.pendingTimeouts.forEach((resolve) => resolve("kill"));
        this.pendingTimeouts.clear();
        break;
      case "extendTimeout": {
        const resolver = this.pendingTimeouts.get(msg.model);
        if (resolver) {
          this.pendingTimeouts.delete(msg.model);
          resolver("extend");
        }
        break;
      }
      case "killModel": {
        const resolver = this.pendingTimeouts.get(msg.model);
        if (resolver) {
          this.pendingTimeouts.delete(msg.model);
          resolver("kill");
        }
        break;
      }
      case "gradeWithClaude":
        this.gradeWithClaude();
        break;
      case "submitGrades":
        this.submitGrades(msg.scores);
        break;
      case "requestLeaderboard":
        this.sendLeaderboard(msg.timeframe);
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

      const promptBuilder = new PromptBuilder();
      const projectType = Config.workspaceRoot ? promptBuilder.detectProjectType(Config.workspaceRoot) : "unknown";

      const review = await this.orchestrator.runReview(this.repo, pr, diff, models, projectType, (model, status) => {
        this.post({ type: "reviewProgress", model, status });
      }, (model, bytes) => {
        this.post({ type: "reviewBytes", model, bytes });
      }, (model) => {
        return new Promise<TimeoutDecision>((resolve) => {
          this.pendingTimeouts.set(model, resolve);
        });
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

  private gradeWithClaude(): void {
    const review = this.store.getLatestReview();
    if (!review) {
      vscode.window.showWarningMessage("Fleet Review: No review to grade");
      return;
    }
    this.store.writeLastReview(review);
    vscode.window.showInformationMessage(
      `Fleet Review: Review data written. Ask Claude Code to read ${this.store.lastReviewPath} and write grades to ${this.store.pendingScoresPath}`,
    );
  }

  private submitGrades(scores: Array<{ model: string; score: number; feedback: string }>): void {
    const review = this.store.getLatestReview();
    if (!review) return;

    const entries = scores.map((s) => ({
      reviewId: review.id,
      model: s.model,
      score: s.score,
      feedback: s.feedback,
      gradedBy: "user" as const,
      timestamp: new Date().toISOString(),
    }));

    this.store.saveScores(entries);
    vscode.window.showInformationMessage(`Fleet Review: Grades saved for ${entries.length} models`);
    this.post({ type: "gradesImported", scores: entries });
  }

  private sendLeaderboard(timeframe: "week" | "month" | "all"): void {
    const stats = this.store.getModelStats(timeframe);
    this.post({ type: "leaderboard", stats });
  }

  private post(msg: ExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(): string {
    const modelsJson = JSON.stringify([...MODEL_NAMES]);
    const defaultsJson = JSON.stringify(Config.defaultModels);
    const timeoutSec = Config.timeoutMs / 1000;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
    --border: var(--vscode-panel-border, rgba(255,255,255,0.07));
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, transparent);
    --sec-btn-bg: var(--vscode-button-secondaryBackground);
    --sec-btn-fg: var(--vscode-button-secondaryForeground);
    --list-hover: var(--vscode-list-hoverBackground);
    --focus-border: var(--vscode-focusBorder);
    --desc-fg: var(--vscode-descriptionForeground);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg);
    padding: 0; font-size: 13px; line-height: 1.4;
  }

  h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
    color: var(--desc-fg); margin: 16px 0 8px; padding: 0;
  }
  h2:first-child { margin-top: 4px; }

  .hidden { display: none !important; }

  /* ─── Tabs — underline style like VS Code Insiders ─── */
  .tabs {
    display: flex; border-bottom: 1px solid var(--border);
    padding: 0 12px; margin-bottom: 0; gap: 0;
  }
  .tabs button {
    width: auto; flex: none; padding: 9px 14px 8px; margin: 0;
    font-size: 12px; font-weight: 400; letter-spacing: 0;
    background: transparent; color: var(--desc-fg);
    border: none; border-bottom: 2px solid transparent;
    border-radius: 0; cursor: pointer; transition: color 0.1s, border-color 0.1s;
  }
  .tabs button:hover { color: var(--fg); background: transparent; }
  .tabs button.active {
    color: var(--fg); font-weight: 500;
    border-bottom-color: var(--btn-bg);
    background: transparent;
  }

  /* ─── Section content padding ─── */
  .tab-content { padding: 4px 20px 20px; }

  /* ─── Select ─── */
  select {
    width: 100%; padding: 6px 8px; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px; font-size: 13px;
    font-family: var(--vscode-font-family); outline: none;
  }
  select:focus { border-color: var(--focus-border); }

  /* ─── Buttons ─── */
  button {
    width: 100%; padding: 8px 14px; background: var(--btn-bg); color: var(--btn-fg);
    border: none; border-radius: 4px; cursor: pointer; font-size: 13px;
    font-family: var(--vscode-font-family); margin-top: 8px; transition: opacity 0.1s;
  }
  button:hover { background: var(--btn-hover); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.secondary {
    background: var(--sec-btn-bg); color: var(--sec-btn-fg);
  }

  /* ─── Checkbox group — list-style like VS Code settings ─── */
  .checkbox-group { display: flex; flex-direction: column; gap: 0; }
  .checkbox-group label {
    display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;
    padding: 6px 8px; border-radius: 4px; margin: 0 -8px; transition: background 0.1s;
  }
  .checkbox-group label:hover { background: var(--list-hover); }
  .checkbox-group input[type="checkbox"] {
    width: 16px; height: 16px; accent-color: var(--btn-bg); flex-shrink: 0;
  }

  /* ─── Progress model rows ─── */
  .model-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 8px; margin: 0 -8px; border-radius: 4px; font-size: 13px;
    border-bottom: none; transition: background 0.1s; flex-wrap: wrap;
  }
  .model-row:hover { background: var(--list-hover); }
  .model-row + .model-row { border-top: 1px solid var(--border); }
  .model-row .name { font-weight: 500; }
  .model-row .elapsed {
    color: var(--desc-fg); font-size: 12px; margin-left: auto; margin-right: 10px;
    font-variant-numeric: tabular-nums;
  }

  /* ─── Badges — pill style ─── */
  .badge {
    padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500;
    letter-spacing: 0.2px;
  }
  .badge.pending { background: rgba(255,255,255,0.06); color: var(--desc-fg); }
  .badge.running { background: var(--vscode-progressBar-background); color: #fff; }
  .badge.done { background: var(--vscode-testing-iconPassed); color: #fff; }
  .badge.failed, .badge.timeout { background: var(--vscode-testing-iconFailed); color: #fff; }
  .badge.timeout-pending { background: var(--vscode-editorWarning-foreground); color: #fff; }

  /* ─── Timeout actions ─── */
  .timeout-actions {
    display: flex; gap: 6px; width: 100%; margin-top: 4px; padding: 0;
  }
  .timeout-actions button {
    width: auto; flex: 1; padding: 5px 10px; font-size: 12px; margin: 0; border-radius: 4px;
  }
  .timeout-actions .extend-btn { background: var(--btn-bg); color: var(--btn-fg); }
  .timeout-actions .kill-btn { background: var(--sec-btn-bg); color: var(--sec-btn-fg); }

  /* ─── Result blocks ─── */
  .result-block { margin-bottom: 4px; }
  .result-block details { border-radius: 4px; overflow: hidden; }
  .result-block summary {
    cursor: pointer; font-size: 13px; font-weight: 500; padding: 8px 8px; margin: 0 -8px;
    border-radius: 4px; transition: background 0.1s; list-style: none;
  }
  .result-block summary::-webkit-details-marker { display: none; }
  .result-block summary::before {
    content: '\\25B6'; display: inline-block; width: 16px; font-size: 9px;
    transition: transform 0.15s; color: var(--desc-fg);
  }
  .result-block details[open] summary::before { transform: rotate(90deg); }
  .result-block summary:hover { background: var(--list-hover); }
  .result-block pre {
    background: var(--input-bg); padding: 12px; border-radius: 4px;
    overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap;
    max-height: 300px; overflow-y: auto; margin-top: 4px;
    border: 1px solid var(--border);
  }

  .error { color: var(--vscode-errorForeground); font-size: 13px; margin: 8px 0; }

  /* ─── Grading ─── */
  .grade-row { display: flex; align-items: center; gap: 8px; margin: 2px 0; padding: 6px 0; }
  .grade-row .name { width: 60px; font-size: 12px; font-weight: 500; color: var(--fg); }
  .grade-row input[type="range"] { flex: 1; height: 4px; accent-color: var(--btn-bg); }
  .grade-row .val {
    width: 24px; text-align: center; font-weight: 700; font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  textarea {
    width: 100%; height: 40px; padding: 6px 8px; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px; font-size: 12px; resize: vertical;
    font-family: var(--vscode-font-family); margin-top: 6px; outline: none;
  }
  textarea:focus { border-color: var(--focus-border); }

  /* ─── Leaderboard ─── */
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th {
    text-align: left; padding: 6px 8px; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--desc-fg); font-weight: 600;
    border-bottom: 1px solid var(--border);
  }
  td { padding: 7px 8px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: var(--list-hover); }
  .score { font-weight: 700; font-variant-numeric: tabular-nums; }
  .score.high { color: var(--vscode-testing-iconPassed); }
  .score.mid { color: var(--vscode-editorWarning-foreground); }
  .score.low { color: var(--vscode-testing-iconFailed); }

  /* ─── Filter pills ─── */
  .filters { display: flex; gap: 4px; margin-bottom: 12px; }
  .filters button {
    width: auto; padding: 4px 12px; font-size: 12px; margin: 0;
    background: transparent; border: 1px solid var(--border); color: var(--desc-fg);
    border-radius: 12px; transition: all 0.1s;
  }
  .filters button:hover { color: var(--fg); border-color: var(--fg); background: transparent; }
  .filters button.active {
    background: var(--btn-bg); color: var(--btn-fg);
    border-color: var(--btn-bg);
  }

  .sparkline svg { display: block; }

  /* ─── Empty states ─── */
  .empty-state { color: var(--desc-fg); padding: 24px 0; text-align: center; font-size: 13px; }
</style>
</head>
<body>

<!-- Navigation tabs -->
<div class="tabs">
  <button class="active" data-tab="review">Review</button>
  <button data-tab="grade">Grade</button>
  <button data-tab="scores">Scores</button>
</div>

<!-- ==================== REVIEW TAB ==================== -->
<div id="tab-review" class="tab-content">

  <!-- State: Select -->
  <div id="state-select">
    <h2>Pull Request</h2>
    <select id="pr-select" disabled>
      <option>Loading PRs...</option>
    </select>

    <h2>Models</h2>
    <div id="model-checkboxes" class="checkbox-group"></div>

    <button id="btn-start" disabled>Start Review</button>
    <button id="btn-refresh" class="secondary">Refresh PRs</button>
    <div id="pr-error" class="error hidden"></div>
  </div>

  <!-- State: Progress -->
  <div id="state-progress" class="hidden">
    <h2>Review in Progress</h2>
    <div id="progress-models"></div>
    <button id="btn-cancel" class="secondary">Cancel</button>
  </div>

  <!-- State: Results -->
  <div id="state-results" class="hidden">
    <h2>Results</h2>
    <div id="results-summary"></div>
    <div id="results-detail"></div>
    <button id="btn-new-review" class="secondary">New Review</button>
  </div>
</div>

<!-- ==================== GRADE TAB ==================== -->
<div id="tab-grade" class="tab-content hidden">
  <div id="grade-empty">
    <p class="empty-state">Run a review first, then grade models here.</p>
  </div>
  <div id="grade-form" class="hidden">
    <h2>Grade Models</h2>
    <div id="grade-sliders"></div>
    <button id="btn-submit-grades">Submit Grades</button>
    <button id="btn-grade-claude" class="secondary">Grade with Claude Code</button>
    <div id="grade-success" class="hidden" style="color:var(--vscode-testing-iconPassed); margin-top:8px; font-size:13px;"></div>
  </div>
</div>

<!-- ==================== SCORES TAB ==================== -->
<div id="tab-scores" class="tab-content hidden">
  <div class="filters">
    <button data-tf="week">Week</button>
    <button data-tf="month">Month</button>
    <button data-tf="all" class="active">All</button>
  </div>
  <div id="leaderboard-content">
    <p class="empty-state">No scores yet.</p>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const ALL_MODELS = ${modelsJson};
  const DEFAULT_MODELS = ${defaultsJson};
  const TIMEOUT_SEC = ${timeoutSec};

  let prs = [];
  let currentReview = null;
  let prLoadTimer = null;

  // ─── Tab switching ───
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['review', 'grade', 'scores'].forEach(t => {
        document.getElementById('tab-' + t).classList.toggle('hidden', t !== btn.dataset.tab);
      });
      if (btn.dataset.tab === 'scores') {
        vscode.postMessage({ type: 'requestLeaderboard', timeframe: 'all' });
      }
      if (btn.dataset.tab === 'grade') {
        renderGradeForm();
      }
    };
  });

  // ─── Review tab ───
  function init() {
    buildModelCheckboxes();
    requestPRs();

    document.getElementById('btn-start').onclick = startReview;
    document.getElementById('btn-refresh').onclick = requestPRs;
    document.getElementById('btn-cancel').onclick = () => vscode.postMessage({ type: 'cancelReview' });
    document.getElementById('btn-new-review').onclick = resetToSelect;
    document.getElementById('btn-submit-grades').onclick = submitGrades;
    document.getElementById('btn-grade-claude').onclick = () => vscode.postMessage({ type: 'gradeWithClaude' });
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
    document.getElementById('model-checkboxes').innerHTML = ALL_MODELS.map(m =>
      '<label><input type="checkbox" value="' + m + '"' +
      (DEFAULT_MODELS.includes(m) ? ' checked' : '') + '> ' + m + '</label>'
    ).join('');
  }

  function getSelectedModels() {
    return Array.from(document.querySelectorAll('#model-checkboxes input:checked')).map(cb => cb.value);
  }

  function showState(name) {
    ['select', 'progress', 'results'].forEach(s =>
      document.getElementById('state-' + s).classList.toggle('hidden', s !== name)
    );
  }

  function resetToSelect() {
    showState('select');
  }

  function startReview() {
    const models = getSelectedModels();
    const prNumber = parseInt(document.getElementById('pr-select').value, 10);
    if (!models.length || isNaN(prNumber)) return;

    showState('progress');
    document.getElementById('progress-models').innerHTML = models.map(m =>
      '<div class="model-row" id="progress-' + m + '">' +
      '<span class="name">' + m + '</span>' +
      '<span class="elapsed"></span>' +
      '<span class="badge pending">pending</span></div>'
    ).join('');

    startElapsedTimer();
    vscode.postMessage({ type: 'startReview', models, prNumber });
  }

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
      '<option value="' + pr.number + '">#' + pr.number + ' ' + escapeHtml(pr.title) +
      ' (+' + pr.additions + '/-' + pr.deletions + ')</option>'
    ).join('');
  }

  var modelStartTimes = {};
  var elapsedTimerId = null;

  function fmtElapsed(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    elapsedTimerId = setInterval(tickElapsed, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimerId) { clearInterval(elapsedTimerId); elapsedTimerId = null; }
  }

  function tickElapsed() {
    var now = Date.now();
    var anyRunning = false;
    Object.keys(modelStartTimes).forEach(function(model) {
      var info = modelStartTimes[model];
      if (!info.ended) {
        anyRunning = true;
        var el = document.querySelector('#progress-' + model + ' .elapsed');
        if (el) el.textContent = fmtElapsed(now - info.start);
      }
    });
    if (!anyRunning) stopElapsedTimer();
  }

  function updateProgress(model, status) {
    var row = document.getElementById('progress-' + model);
    if (!row) return;
    var badge = row.querySelector('.badge');
    badge.className = 'badge ' + status;

    var labels = { pending: 'pending', running: 'running', done: 'done',
      failed: 'failed', timeout: 'timed out', 'timeout-pending': 'timed out' };
    badge.textContent = labels[status] || status;

    // Remove any existing timeout action buttons
    var existing = row.querySelector('.timeout-actions');
    if (existing) existing.remove();

    if (status === 'timeout-pending') {
      var actions = document.createElement('div');
      actions.className = 'timeout-actions';
      var extBtn = document.createElement('button');
      extBtn.className = 'extend-btn';
      extBtn.textContent = 'Extend ' + TIMEOUT_SEC + 's';
      extBtn.onclick = function() { vscode.postMessage({ type: 'extendTimeout', model: model }); };
      var killBtn = document.createElement('button');
      killBtn.className = 'kill-btn';
      killBtn.textContent = 'Kill';
      killBtn.onclick = function() { vscode.postMessage({ type: 'killModel', model: model }); };
      actions.appendChild(extBtn);
      actions.appendChild(killBtn);
      row.appendChild(actions);
    }

    if (status === 'running' && !modelStartTimes[model]) {
      modelStartTimes[model] = { start: Date.now(), ended: false };
    }
    if (status === 'running' && modelStartTimes[model] && modelStartTimes[model].ended) {
      // Resumed after extend — restart timer
      modelStartTimes[model].ended = false;
      if (!elapsedTimerId) startElapsedTimer();
    }
    if (status === 'done' || status === 'failed' || status === 'timeout') {
      if (modelStartTimes[model]) modelStartTimes[model].ended = true;
    }
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    return (b / 1024).toFixed(1) + ' KB';
  }

  function updateBytes(model, bytes) {
    var el = document.querySelector('#progress-' + model + ' .elapsed');
    if (!el || !modelStartTimes[model] || modelStartTimes[model].ended) return;
    var now = Date.now();
    var time = fmtElapsed(now - modelStartTimes[model].start);
    el.textContent = time + ' · ' + fmtBytes(bytes);
  }

  function renderResults(review) {
    showState('results');
    const models = Object.keys(review.results);
    const ok = models.filter(m => review.results[m].success);
    const fail = models.filter(m => !review.results[m].success);

    document.getElementById('results-summary').innerHTML =
      '<p>' + ok.length + '/' + models.length + ' completed for PR #' + review.prNumber + '</p>' +
      (fail.length ? '<p class="error">Failed: ' + fail.join(', ') + '</p>' : '');

    document.getElementById('results-detail').innerHTML = models.map(m => {
      const r = review.results[m];
      return '<details class="result-block"' + (r.success ? ' open' : '') + '>' +
        '<summary>' + m + (r.success ? ' ✓' : ' ✗') + ' — ' + (r.durationMs / 1000).toFixed(1) + 's</summary>' +
        (r.success
          ? '<pre>' + escapeHtml(r.output) + '</pre>'
          : '<p class="error">' + escapeHtml(r.error || 'Error') + '</p>') +
        '</details>';
    }).join('');
  }

  // ─── Grade tab ───
  function renderGradeForm() {
    if (!currentReview) {
      document.getElementById('grade-empty').classList.remove('hidden');
      document.getElementById('grade-form').classList.add('hidden');
      return;
    }

    document.getElementById('grade-empty').classList.add('hidden');
    document.getElementById('grade-form').classList.remove('hidden');
    document.getElementById('grade-success').classList.add('hidden');
    document.getElementById('btn-submit-grades').disabled = false;

    const models = Object.entries(currentReview.results).filter(([,r]) => r.success);
    document.getElementById('grade-sliders').innerHTML = models.map(([m]) =>
      '<div class="grade-row" data-model="' + m + '">' +
      '<span class="name">' + m + '</span>' +
      '<input type="range" min="1" max="10" value="5" oninput="this.parentElement.querySelector(\\'.val\\').textContent=this.value">' +
      '<span class="val">5</span></div>'
    ).join('');
  }

  function submitGrades() {
    if (!currentReview) return;
    const models = Object.keys(currentReview.results).filter(m => currentReview.results[m].success);
    const scores = models.map(m => {
      const row = document.querySelector('.grade-row[data-model="' + m + '"]');
      return {
        model: m,
        score: parseInt(row.querySelector('input').value, 10),
        feedback: '',
      };
    });

    vscode.postMessage({ type: 'submitGrades', scores });
    document.getElementById('btn-submit-grades').disabled = true;
    document.getElementById('grade-success').classList.remove('hidden');
    document.getElementById('grade-success').textContent =
      'Saved: ' + scores.map(s => s.model + '=' + s.score).join(', ');
  }

  // ─── Scores tab ───
  document.querySelectorAll('.filters button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      vscode.postMessage({ type: 'requestLeaderboard', timeframe: btn.dataset.tf });
    };
  });

  function renderLeaderboard(stats) {
    const el = document.getElementById('leaderboard-content');
    if (!stats.length) {
      el.innerHTML = '<p class="empty-state">No scores for this period.</p>';
      return;
    }

    let html = '<table><thead><tr><th>Model</th><th>Avg</th><th>N</th><th>Trend</th></tr></thead><tbody>';
    for (const s of stats) {
      const avg = s.avgScore.toFixed(1);
      const cls = s.avgScore >= 7 ? 'high' : s.avgScore >= 5 ? 'mid' : 'low';
      html += '<tr><td>' + s.model + '</td>' +
        '<td><span class="score ' + cls + '">' + avg + '</span></td>' +
        '<td>' + s.totalReviews + '</td>' +
        '<td class="sparkline">' + sparkline(s.recentScores, 60, 18) + '</td></tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  function sparkline(scores, w, h) {
    if (!scores || scores.length < 2) return '—';
    const pts = scores.map((v, i) => {
      const x = (i / (scores.length - 1)) * w;
      const y = h - ((v - 1) / 9) * h;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const last = scores[scores.length - 1];
    const c = last >= 7 ? 'var(--vscode-testing-iconPassed)' : last >= 5 ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-testing-iconFailed)';
    return '<svg width="' + w + '" height="' + h + '"><polyline points="' + pts + '" fill="none" stroke="' + c + '" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  }

  // ─── Message handler ───
  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
      case 'prs':
        prs = msg.prs;
        renderPRs();
        break;
      case 'reviewProgress': updateProgress(msg.model, msg.status); break;
      case 'reviewBytes': updateBytes(msg.model, msg.bytes); break;
      case 'reviewComplete': stopElapsedTimer(); modelStartTimes = {}; currentReview = msg.review; renderResults(msg.review); break;
      case 'reviewError':
        stopElapsedTimer(); modelStartTimes = {};
        showState('select');
        document.getElementById('pr-error').textContent = msg.error;
        document.getElementById('pr-error').classList.remove('hidden');
        break;
      case 'leaderboard': renderLeaderboard(msg.stats); break;
      case 'error':
        showPrError(msg.message, 'Failed to load PRs');
        break;
    }
  });

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // Defer init so the VS Code webview message bridge is ready
  setTimeout(init, 50);
</script>
</body>
</html>`;
  }
}
