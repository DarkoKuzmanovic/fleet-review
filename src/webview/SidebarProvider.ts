import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

import { ExtensionMessage, API_MODELS, ModelName, MODEL_NAMES, TimeoutDecision, WebviewMessage } from "../types";
import { Config } from "../config";
import { GitHubClient } from "../github/GitHubClient";
import { CliDispatcher } from "../review/CliDispatcher";
import { PromptBuilder } from "../review/PromptBuilder";
import { ReviewOrchestrator } from "../review/ReviewOrchestrator";
import { ScoreStore } from "../scoring/ScoreStore";
import { ESCAPE_HTML_JS } from "./webviewUtils";

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private orchestrator: ReviewOrchestrator;
  private promptBuilder: PromptBuilder;
  private repo = "";
  private lastReview: import("../types").ReviewRecord | null = null;
  private pendingTimeouts = new Map<string, (decision: TimeoutDecision) => void>();

  constructor(
    private extensionUri: vscode.Uri,
    private github: GitHubClient,
    private store: ScoreStore,
    private output: vscode.OutputChannel,
  ) {
    this.promptBuilder = new PromptBuilder();
    this.orchestrator = new ReviewOrchestrator(github, new CliDispatcher(output), this.promptBuilder, store, output);
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

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg));

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
      case "retryModel":
        if (!MODEL_NAMES.includes(msg.model)) {
          this.post({ type: "error", message: `Invalid model: ${msg.model}` });
          break;
        }
        await this.retryModel(msg.model);
        break;
      case "retryAllFailed":
        await this.retryAllFailed();
        break;
      case "checkModelHealth":
        await this.checkModelHealth();
        break;
      case "requestReviewHistory":
        this.post({ type: "reviewHistory", reviews: this.store.getRecentReviews(20) });
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

      const review = await this.orchestrator.runReview(
        this.repo,
        pr,
        diff,
        models,
        projectType,
        (model, status) => {
          this.post({ type: "reviewProgress", model, status });
        },
        (model, bytes) => {
          this.post({ type: "reviewBytes", model, bytes });
        },
        (model) => {
          return new Promise<TimeoutDecision>((resolve) => {
            this.pendingTimeouts.set(model, resolve);
          });
        },
        (model, text) => {
          this.post({ type: "reviewChunk", model, text });
        },
      );

      this.lastReview = review;
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
    } finally {
      for (const resolve of this.pendingTimeouts.values()) {
        resolve("kill");
      }
      this.pendingTimeouts.clear();
    }
  }

  private gradeWithClaude(): void {
    const review = this.store.getLatestReview();
    if (!review) {
      vscode.window.showWarningMessage("Fleet Review: No review to grade");
      return;
    }
    this.store.writeLastReview(review);

    const models = Object.entries(review.results)
      .filter(([, r]) => r.success)
      .map(([m]) => m);

    const prompt = [
      `Read the review data from ${this.store.lastReviewPath}`,
      ``,
      `Grade each model (${models.join(', ')}) on a scale of 1-10 based on:`,
      `- Accuracy of findings (are they real issues?)`,
      `- Severity calibration (are severities appropriate?)`,
      `- Actionability (are suggested fixes useful?)`,
      `- Coverage (did it catch important issues?)`,
      ``,
      `Write your grades to ${this.store.pendingScoresPath} in this exact format:`,
      `{`,
      `  "reviewId": "<id from the review file>",`,
      `  "scores": [`,
      `    { "model": "<name>", "score": <1-10>, "feedback": "<one line>" }`,
      `  ]`,
      `}`,
    ].join('\n');

    this.post({ type: 'gradePromptReady', prompt });
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

  private async checkModelHealth(): Promise<void> {
    const execFileAsync = promisify(execFile);
    const health: Record<string, boolean> = {};

    for (const model of MODEL_NAMES) {
      if (API_MODELS.has(model)) {
        health[model] = Config.nanoGptApiKey.length > 0;
      } else {
        try {
          await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [model]);
          health[model] = true;
        } catch {
          health[model] = false;
        }
      }
    }

    this.post({ type: "modelHealth", health });
  }

  private async retryModelCore(model: ModelName): Promise<void> {
    if (!this.lastReview) {
      throw new Error("No review to retry");
    }

    const updated = await this.orchestrator.retrySingleModel(
      model,
      this.lastReview,
      (m, status) => this.post({ type: "reviewProgress", model: m, status }),
      (m, bytes) => this.post({ type: "reviewBytes", model: m, bytes }),
      (m) => new Promise<TimeoutDecision>((resolve) => {
        this.pendingTimeouts.set(m, resolve);
      }),
      (m, text) => this.post({ type: "reviewChunk", model: m, text }),
    );

    this.lastReview = updated;
  }

  private async retryModel(model: ModelName): Promise<void> {
    try {
      await this.retryModelCore(model);
      if (this.lastReview) {
        this.post({ type: "reviewComplete", review: this.lastReview });
      }
    } catch (err) {
      this.post({ type: "reviewError", error: err instanceof Error ? err.message : String(err) });
    } finally {
      for (const resolve of this.pendingTimeouts.values()) {
        resolve("kill");
      }
      this.pendingTimeouts.clear();
    }
  }

  private async retryAllFailed(): Promise<void> {
    if (!this.lastReview) return;

    const failedModels = Object.entries(this.lastReview.results)
      .filter(([, r]) => !r.success)
      .map(([m]) => m as ModelName);

    if (failedModels.length === 0) return;

    try {
      for (const model of failedModels) {
        await this.retryModelCore(model);
      }
      if (this.lastReview) {
        this.post({ type: "reviewComplete", review: this.lastReview });
      }
    } catch (err) {
      this.post({ type: "reviewError", error: err instanceof Error ? err.message : String(err) });
    } finally {
      for (const resolve of this.pendingTimeouts.values()) {
        resolve("kill");
      }
      this.pendingTimeouts.clear();
    }
  }

  private post(msg: ExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(): string {
    const modelsJson = JSON.stringify([...MODEL_NAMES]);
    const defaultsJson = JSON.stringify(Config.defaultModels);
    const timeoutSec = Config.timeoutMs / 1000;
    const modelTimeoutsJson = JSON.stringify(Config.modelTimeouts);
    const apiModelsJson = JSON.stringify([...API_MODELS]);
    const diffSizeThreshold = Config.diffSizeWarningThreshold;
    const modelStatsJson = JSON.stringify(this.store.getModelStats("all"));
    const webview = this.view!.webview;
    const cliIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "cli.svg"));
    const apiIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "api.svg"));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${webview.cspSource};">
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
  .model-row .elapsed-time {
    color: var(--desc-fg); font-size: 12px; margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .model-row .elapsed-bytes {
    color: var(--desc-fg); font-size: 12px; margin-right: 10px; margin-left: 4px;
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
  .result-output-wrapper {
    position: relative;
  }
  .copy-btn {
    position: absolute; top: 6px; right: 6px;
    width: auto; padding: 3px 8px; margin: 0; font-size: 11px;
    background: var(--sec-btn-bg); color: var(--sec-btn-fg);
    border: 1px solid var(--border); border-radius: 4px;
    cursor: pointer; opacity: 0; transition: opacity 0.15s;
  }
  .result-output-wrapper:hover .copy-btn { opacity: 1; }
  .copy-btn:hover { background: var(--btn-bg); color: var(--btn-fg); }

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

  /* ─── Model type glyph ─── */
  .model-glyph {
    display: inline-block;
    width: 14px;
    height: 14px;
    vertical-align: middle;
    margin-right: 2px;
    flex-shrink: 0;
    background-color: currentColor;
    opacity: 0.85;
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    -webkit-mask-size: contain;
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
  }

  /* ─── Empty states ─── */
  .empty-state { color: var(--desc-fg); padding: 24px 0; text-align: center; font-size: 13px; }

  /* ─── Skeleton loading ─── */
  @keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  @keyframes entranceSlide {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .entrance { animation: entranceSlide 0.3s ease-out forwards; }
  .skeleton {
    background: linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s ease-in-out infinite;
    border-radius: 4px;
  }
  .skeleton-row {
    height: 32px;
    margin-bottom: 6px;
  }
  .skeleton-row:last-child { margin-bottom: 0; }
  .skeleton-row.narrow { width: 70%; }
  .skeleton-row.short { height: 18px; }
  .skeleton-table-row {
    display: flex; gap: 12px; padding: 7px 0;
    border-bottom: 1px solid var(--border);
  }
  .skeleton-table-row .skeleton-cell { height: 14px; flex: 1; }
  .skeleton-table-row .skeleton-cell:first-child { flex: 2; }
  .skeleton-table-row .skeleton-cell:last-child { flex: 1.5; }

  /* ─── Summary card ─── */
  .summary-card {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: 1px; background: var(--border); border: 1px solid var(--border);
    border-radius: 6px; overflow: hidden; margin-bottom: 12px;
  }
  .summary-stat {
    display: flex; flex-direction: column; gap: 2px;
    padding: 10px 12px; background: var(--bg);
  }
  .summary-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--desc-fg); font-weight: 600;
  }
  .summary-value { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .summary-detail { font-size: 11px; color: var(--desc-fg); }

  /* ─── Progress ring ─── */
  .progress-ring {
    display: none; width: 20px; height: 20px; border-radius: 50%;
    flex-shrink: 0; margin-right: 6px;
    background: conic-gradient(var(--vscode-testing-iconPassed) 0deg, transparent 0deg);
    -webkit-mask: radial-gradient(circle, transparent 55%, black 56%);
    mask: radial-gradient(circle, transparent 55%, black 56%);
  }
  .progress-ring.active { display: inline-block; }
  @keyframes pulse-ring {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .progress-ring.extended {
    animation: pulse-ring 1.5s ease-in-out infinite;
    box-shadow: 0 0 4px var(--vscode-testing-iconFailed);
  }

  /* ─── Chunk preview ─── */
  .chunk-preview {
    display: none; width: 100%; margin-top: 4px; padding: 6px 8px;
    background: var(--input-bg); border-radius: 4px; border: 1px solid var(--border);
    font-size: 11px; line-height: 1.3; color: var(--desc-fg);
    max-height: 60px; overflow: hidden; white-space: pre-wrap;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .chunk-preview.active { display: block; }

  /* ─── Warning banner ─── */
  /* ─── Health dots ─── */
  .health-dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    background: var(--desc-fg); opacity: 0.4; flex-shrink: 0;
  }
  .health-dot.available { background: var(--vscode-testing-iconPassed); opacity: 1; }
  .health-dot.unavailable { background: var(--vscode-testing-iconFailed); opacity: 1; }
  .suggested-badge {
    display: none; padding: 1px 6px; border-radius: 8px; font-size: 10px;
    font-weight: 600; background: var(--vscode-testing-iconPassed); color: #fff;
    margin-left: auto;
  }
  .suggested-badge.visible { display: inline-block; }

  /* ─── History list ─── */
  .history-list { max-height: 240px; overflow-y: auto; overflow-x: hidden; min-width: 0; }
  .history-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 8px; margin: 0 -8px; border-radius: 4px; cursor: pointer;
    font-size: 12px; transition: background 0.1s; min-width: 0;
  }
  .history-item:hover { background: var(--list-hover); }
  .history-title {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0; flex: 1;
  }
  .history-pr { font-weight: 500; }
  .history-date { color: var(--desc-fg); font-size: 11px; white-space: nowrap; margin-left: 8px; flex-shrink: 0; }

  /* ─── Comparison view ─── */
  .compare-panel { margin-top: 12px; }
  .compare-tabs {
    display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 8px;
  }
  .compare-tabs button {
    width: auto; flex: none; padding: 6px 12px; margin: 0; font-size: 12px;
    background: transparent; color: var(--desc-fg); border: none;
    border-bottom: 2px solid transparent; border-radius: 0; cursor: pointer;
  }
  .compare-tabs button:hover { color: var(--fg); background: transparent; }
  .compare-tabs button.active {
    color: var(--fg); font-weight: 500; border-bottom-color: var(--btn-bg); background: transparent;
  }
  .compare-content pre {
    background: var(--input-bg); padding: 12px; border-radius: 4px;
    overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap;
    max-height: 400px; overflow-y: auto; border: 1px solid var(--border);
  }
  .compare-model-header {
    display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 12px;
  }
  .compare-model-header .score-badge {
    padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 600;
  }
  .finding-tag {
    display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px;
    font-weight: 600; margin-right: 4px; margin-bottom: 2px;
  }
  .finding-tag.consensus { background: var(--vscode-testing-iconPassed); color: #fff; }
  .finding-tag.unique { background: var(--vscode-editorWarning-foreground); color: #fff; }
  .consensus-summary { margin-bottom: 12px; }
  .consensus-summary h3 {
    font-size: 12px; font-weight: 600; margin: 8px 0 4px; color: var(--fg);
  }
  .consensus-item {
    padding: 4px 8px; font-size: 12px; border-left: 3px solid var(--vscode-testing-iconPassed);
    margin-bottom: 4px; background: rgba(255,255,255,0.02); border-radius: 0 4px 4px 0;
  }
  .unique-item {
    padding: 4px 8px; font-size: 12px; border-left: 3px solid var(--vscode-editorWarning-foreground);
    margin-bottom: 4px; background: rgba(255,255,255,0.02); border-radius: 0 4px 4px 0;
  }

  .warning-banner {
    padding: 8px 12px; margin: 8px 0; border-radius: 4px; font-size: 12px;
    background: rgba(255,204,0,0.08);
    border-left: 3px solid var(--vscode-editorWarning-foreground);
    color: var(--fg); line-height: 1.4;
  }
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
    <div id="pr-skeleton">
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row narrow"></div>
      <div class="skeleton skeleton-row" style="width:85%"></div>
    </div>
    <select id="pr-select" class="hidden" disabled>
      <option>Loading PRs...</option>
    </select>

    <div id="diff-size-warning" class="warning-banner hidden"></div>

    <h2>Models</h2>
    <div id="model-checkboxes" class="checkbox-group"></div>

    <button id="btn-start" disabled>Start Review</button>
    <button id="btn-refresh" class="secondary">Refresh PRs</button>
    <div id="pr-error" class="error hidden"></div>

    <h2>History</h2>
    <div id="history-list" class="history-list">
      <p class="empty-state">No past reviews.</p>
    </div>
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
    <button id="btn-compare" class="secondary">Compare Models</button>
    <div id="compare-panel" class="compare-panel hidden"></div>
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
    <div id="grade-prompt-block" class="hidden" style="margin-top:12px;">
      <h2>Claude Code Prompt</h2>
      <div class="result-output-wrapper">
        <pre id="grade-prompt-text" style="max-height:200px;"></pre>
        <button class="copy-btn" id="btn-copy-grade-prompt">Copy</button>
      </div>
    </div>
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
    <div id="scores-skeleton">
      <div class="skeleton-table-row"><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div></div>
      <div class="skeleton-table-row"><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div></div>
      <div class="skeleton-table-row"><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div></div>
      <div class="skeleton-table-row"><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div><div class="skeleton skeleton-cell"></div></div>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const ALL_MODELS = ${modelsJson};
  const DEFAULT_MODELS = ${defaultsJson};
  const TIMEOUT_SEC = ${timeoutSec};
  const MODEL_TIMEOUTS = ${modelTimeoutsJson};
  const API_MODELS = new Set(${apiModelsJson});
  const CLI_ICON = ${JSON.stringify(cliIconUri.toString())};
  const API_ICON = ${JSON.stringify(apiIconUri.toString())};
  const DIFF_SIZE_THRESHOLD = ${diffSizeThreshold};
  const MODEL_STATS = ${modelStatsJson};

  let prs = [];
  let currentReview = null;
  let prLoadTimer = null;
  var chunkBuffers = {};
  var reviewHistory = [];
  var isViewingHistory = false;

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
    vscode.postMessage({ type: 'checkModelHealth' });
    vscode.postMessage({ type: 'requestReviewHistory' });

    document.getElementById('btn-start').onclick = startReview;
    document.getElementById('btn-refresh').onclick = requestPRs;
    document.getElementById('btn-cancel').onclick = () => vscode.postMessage({ type: 'cancelReview' });
    document.getElementById('btn-new-review').onclick = resetToSelect;
    document.getElementById('btn-compare').onclick = function() {
      var panel = document.getElementById('compare-panel');
      if (panel.classList.contains('hidden')) {
        if (currentReview) buildComparison(currentReview);
        panel.classList.remove('hidden');
        document.getElementById('btn-compare').textContent = 'Hide Comparison';
      } else {
        panel.classList.add('hidden');
        document.getElementById('btn-compare').textContent = 'Compare Models';
      }
    };
    document.getElementById('btn-submit-grades').onclick = submitGrades;
    document.getElementById('btn-grade-claude').onclick = () => vscode.postMessage({ type: 'gradeWithClaude' });
    document.getElementById('btn-copy-grade-prompt').onclick = function() {
      var text = document.getElementById('grade-prompt-text').textContent || '';
      navigator.clipboard.writeText(text).then(function() {
        document.getElementById('btn-copy-grade-prompt').textContent = 'Copied!';
        setTimeout(function() { document.getElementById('btn-copy-grade-prompt').textContent = 'Copy'; }, 1500);
      }).catch(function() {
        document.getElementById('btn-copy-grade-prompt').textContent = 'Failed';
        setTimeout(function() { document.getElementById('btn-copy-grade-prompt').textContent = 'Copy'; }, 1500);
      });
    };
  }

  function clearPrLoadTimer() {
    if (prLoadTimer !== null) {
      clearTimeout(prLoadTimer);
      prLoadTimer = null;
    }
  }

  function showPrError(message, optionLabel) {
    clearPrLoadTimer();
    var skel = document.getElementById('pr-skeleton');
    if (skel) skel.classList.add('hidden');
    const sel = document.getElementById('pr-select');
    sel.classList.remove('hidden');
    sel.disabled = false;
    sel.innerHTML = '<option disabled>' + optionLabel + '</option>';
    document.getElementById('btn-start').disabled = true;
    document.getElementById('pr-error').textContent = message;
    document.getElementById('pr-error').classList.remove('hidden');
  }

  function requestPRs() {
    clearPrLoadTimer();
    var skel = document.getElementById('pr-skeleton');
    var sel = document.getElementById('pr-select');
    if (skel) skel.classList.remove('hidden');
    sel.classList.add('hidden');
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

  function modelGlyphHtml(m) {
    var isApi = API_MODELS.has(m);
    var src = isApi ? API_ICON : CLI_ICON;
    var title = isApi ? 'API' : 'CLI';
    var escapedSrc = escapeHtml(src);
    return '<span class="model-glyph" title="' + title + '" style="-webkit-mask-image:url(' + escapedSrc + ');mask-image:url(' + escapedSrc + ');"></span> ';
  }

  function buildModelCheckboxes() {
    document.getElementById('model-checkboxes').innerHTML = ALL_MODELS.map(m =>
      '<label><input type="checkbox" value="' + m + '"' +
      (DEFAULT_MODELS.includes(m) ? ' checked' : '') + '> ' +
      '<span class="health-dot" data-model="' + m + '" title="checking..."></span> ' +
      modelGlyphHtml(m) + m +
      '<span class="suggested-badge" data-model="' + m + '">Suggested</span></label>'
    ).join('');
    applySuggestedBadges();
  }

  function applySuggestedBadges() {
    if (!MODEL_STATS || !MODEL_STATS.length) return;
    var suggested = MODEL_STATS
      .filter(function(s) { return s.totalReviews >= 3 && s.avgScore >= 7; })
      .slice(0, 3)
      .map(function(s) { return s.model; });
    suggested.forEach(function(m) {
      var badge = document.querySelector('.suggested-badge[data-model="' + m + '"]');
      if (badge) badge.classList.add('visible');
    });
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
    isViewingHistory = false;
    chunkBuffers = {};
    document.getElementById('progress-models').innerHTML = models.map(m =>
      '<div class="model-row entrance" id="progress-' + m + '">' +
      '<span class="progress-ring" id="ring-' + m + '"></span>' +
      '<span class="name">' + modelGlyphHtml(m) + m + '</span>' +
      '<span class="elapsed-time"></span>' +
      '<span class="elapsed-bytes"></span>' +
      '<span class="badge pending">pending</span>' +
      '<pre class="chunk-preview" id="chunks-' + m + '"></pre>' +
      '</div>'
    ).join('');

    startElapsedTimer();
    vscode.postMessage({ type: 'startReview', models, prNumber });
  }

  function renderPRs() {
    clearPrLoadTimer();
    var skel = document.getElementById('pr-skeleton');
    if (skel) skel.classList.add('hidden');
    const sel = document.getElementById('pr-select');
    sel.classList.remove('hidden');
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
    sel.onchange = checkDiffSize;
    checkDiffSize();
  }

  function checkDiffSize() {
    var sel = document.getElementById('pr-select');
    var warn = document.getElementById('diff-size-warning');
    var prNum = parseInt(sel.value, 10);
    var pr = prs.find(function(p) { return p.number === prNum; });
    if (pr) {
      var total = pr.additions + pr.deletions;
      if (total > DIFF_SIZE_THRESHOLD) {
        warn.textContent = 'This PR has ' + total + ' changed lines. Reviews may be slower or truncated.';
        warn.classList.remove('hidden');
      } else {
        warn.classList.add('hidden');
      }
    } else {
      warn.classList.add('hidden');
    }
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
        var el = document.querySelector('#progress-' + model + ' .elapsed-time');
        if (el) el.textContent = fmtElapsed(now - info.start);

        // Update progress ring
        var ring = document.getElementById('ring-' + model);
        if (ring) {
          var timeout = (MODEL_TIMEOUTS[model] ?? TIMEOUT_SEC) * 1000;
          if (info.extended) {
            // Extended run — ring restarts from extend point, always red with pulse
            var extElapsed = now - (info.extendedAt || info.start);
            var extPct = Math.min(extElapsed / timeout, 1);
            var extDeg = Math.round(extPct * 360);
            var extColor = 'var(--vscode-testing-iconFailed)';
            ring.style.background = 'conic-gradient(' + extColor + ' 0deg, ' + extColor + ' ' + extDeg + 'deg, rgba(255,60,60,0.2) ' + extDeg + 'deg)';
          } else {
            var elapsed = now - info.start;
            var pct = Math.min(elapsed / timeout, 1);
            var deg = Math.round(pct * 360);
            var color = pct < 0.7 ? 'var(--vscode-testing-iconPassed)'
              : pct < 0.9 ? 'var(--vscode-editorWarning-foreground)'
              : 'var(--vscode-testing-iconFailed)';
            ring.style.background = 'conic-gradient(' + color + ' 0deg, ' + color + ' ' + deg + 'deg, transparent ' + deg + 'deg)';
          }
        }
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
      var modelTimeout = (MODEL_TIMEOUTS[model] ?? TIMEOUT_SEC);
      extBtn.textContent = 'Extend ' + modelTimeout + 's';
      extBtn.onclick = function() { vscode.postMessage({ type: 'extendTimeout', model: model }); };
      var killBtn = document.createElement('button');
      killBtn.className = 'kill-btn';
      killBtn.textContent = 'Kill';
      killBtn.onclick = function() { vscode.postMessage({ type: 'killModel', model: model }); };
      actions.appendChild(extBtn);
      actions.appendChild(killBtn);
      row.appendChild(actions);
    }

    // Show/hide progress ring
    var ring = document.getElementById('ring-' + model);
    if (ring) {
      if (status === 'running' || status === 'timeout-pending') {
        ring.classList.add('active');
      } else {
        ring.classList.remove('active', 'extended');
      }
    }

    if (status === 'running' && !modelStartTimes[model]) {
      modelStartTimes[model] = { start: Date.now(), ended: false, extended: false };
    }
    if (status === 'running' && modelStartTimes[model] && modelStartTimes[model].ended) {
      // Resumed after extend — mark as extended and reset ring
      modelStartTimes[model].ended = false;
      modelStartTimes[model].extended = true;
      modelStartTimes[model].extendedAt = Date.now();
      var extRing = document.getElementById('ring-' + model);
      if (extRing) extRing.classList.add('extended');
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
    var el = document.querySelector('#progress-' + model + ' .elapsed-bytes');
    if (!el || !modelStartTimes[model] || modelStartTimes[model].ended) return;
    el.textContent = '· ' + fmtBytes(bytes);
  }

  function renderSummaryCard(review) {
    var models = Object.keys(review.results);
    var ok = models.filter(function(m) { return review.results[m].success; });
    var fail = models.filter(function(m) { return !review.results[m].success; });
    var durations = models.map(function(m) { return review.results[m].durationMs; });
    var avgDur = durations.length ? durations.reduce(function(a, b) { return a + b; }, 0) / durations.length / 1000 : 0;
    var fastest = durations.length ? Math.min.apply(null, durations) / 1000 : 0;
    var slowest = durations.length ? Math.max.apply(null, durations) / 1000 : 0;
    var posted = models.filter(function(m) { return review.results[m].postedToGitHub; }).length;
    var totalKB = models.reduce(function(sum, m) { return sum + review.results[m].output.length; }, 0) / 1024;

    var statusDetail = ok.length + '/' + models.length + ' done';
    if (fail.length) statusDetail += ', ' + fail.length + ' failed';

    // Aggregate token usage from API models
    var totalPromptTokens = 0;
    var totalCompletionTokens = 0;
    models.forEach(function(m) {
      var tu = review.results[m].tokenUsage;
      if (tu) {
        totalPromptTokens += tu.prompt;
        totalCompletionTokens += tu.completion;
      }
    });
    var hasTokens = totalPromptTokens > 0 || totalCompletionTokens > 0;
    var totalTokens = totalPromptTokens + totalCompletionTokens;

    return '<div class="summary-card">' +
      '<div class="summary-stat"><div class="summary-label">Status</div>' +
        '<div class="summary-value">' + ok.length + '/' + models.length + '</div>' +
        '<div class="summary-detail">' + (fail.length ? fail.join(', ') + ' failed' : 'all passed') + '</div></div>' +
      '<div class="summary-stat"><div class="summary-label">Duration</div>' +
        '<div class="summary-value">' + avgDur.toFixed(1) + 's</div>' +
        '<div class="summary-detail">' + fastest.toFixed(0) + 's – ' + slowest.toFixed(0) + 's</div></div>' +
      '<div class="summary-stat"><div class="summary-label">GitHub</div>' +
        '<div class="summary-value">' + posted + '</div>' +
        '<div class="summary-detail">comment' + (posted !== 1 ? 's' : '') + ' posted</div></div>' +
      '<div class="summary-stat"><div class="summary-label">Output</div>' +
        '<div class="summary-value">' + totalKB.toFixed(1) + '</div>' +
        '<div class="summary-detail">KB total</div></div>' +
      (hasTokens ? '<div class="summary-stat"><div class="summary-label">Tokens</div>' +
        '<div class="summary-value">' + (totalTokens >= 1000 ? (totalTokens / 1000).toFixed(1) + 'K' : totalTokens) + '</div>' +
        '<div class="summary-detail">' + totalPromptTokens + ' in / ' + totalCompletionTokens + ' out</div></div>' : '') +
    '</div>';
  }

  function renderResults(review) {
    showState('results');
    const models = Object.keys(review.results);

    document.getElementById('results-summary').innerHTML = renderSummaryCard(review);

    var detailEl = document.getElementById('results-detail');
    detailEl.innerHTML = '';
    var hasFailed = false;

    models.forEach(function(m) {
      var r = review.results[m];
      var block = document.createElement('div');
      block.className = 'result-block';
      var details = document.createElement('details');
      if (r.success) details.open = true;
      var summary = document.createElement('summary');
      summary.innerHTML = modelGlyphHtml(m) + m + (r.success ? ' ✓' : ' ✗') + ' — ' + (r.durationMs / 1000).toFixed(1) + 's';
      details.appendChild(summary);

      if (r.success) {
        var outputKB = (r.output.length / 1024).toFixed(1);
        var innerDetails = document.createElement('details');
        innerDetails.open = true;
        var innerSummary = document.createElement('summary');
        innerSummary.textContent = 'Output (' + outputKB + ' KB)';
        innerSummary.style.cssText = 'font-size:11px;color:var(--desc-fg);cursor:pointer;padding:4px 0;';
        innerDetails.appendChild(innerSummary);
        var wrapper = document.createElement('div');
        wrapper.className = 'result-output-wrapper';
        var pre = document.createElement('pre');
        pre.textContent = r.output;
        var copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.onclick = function() {
          navigator.clipboard.writeText(r.output).then(function() {
            copyBtn.textContent = 'Copied!';
            setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500);
          }).catch(function() {
            copyBtn.textContent = 'Failed';
            setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500);
          });
        };
        wrapper.appendChild(pre);
        wrapper.appendChild(copyBtn);
        innerDetails.appendChild(wrapper);
        details.appendChild(innerDetails);
      } else {
        hasFailed = true;
        var errP = document.createElement('p');
        errP.className = 'error';
        errP.textContent = r.error || 'Error';
        details.appendChild(errP);
        var retryBtn = document.createElement('button');
        retryBtn.className = 'secondary';
        retryBtn.textContent = 'Retry ' + m;
        retryBtn.style.marginTop = '8px';
        if (isViewingHistory) {
          retryBtn.disabled = true;
          retryBtn.title = 'Cannot retry from history — start a new review';
        } else {
          retryBtn.onclick = function() { vscode.postMessage({ type: 'retryModel', model: m }); };
        }
        details.appendChild(retryBtn);
      }

      block.appendChild(details);
      detailEl.appendChild(block);
    });

    if (hasFailed) {
      var retryAllBtn = document.createElement('button');
      retryAllBtn.className = 'secondary';
      retryAllBtn.textContent = 'Retry All Failed';
      retryAllBtn.style.marginTop = '4px';
      if (isViewingHistory) {
        retryAllBtn.disabled = true;
        retryAllBtn.title = 'Cannot retry from history — start a new review';
      } else {
        retryAllBtn.onclick = function() { vscode.postMessage({ type: 'retryAllFailed' }); };
      }
      detailEl.appendChild(retryAllBtn);
    }
  }

  // ─── Comparison view ───
  function parseFindings(output) {
    var findings = [];
    // Match the audit output format: #### [N]. [Title] — Severity: ...
    var blocks = output.split(/(?=####\\s*\\[?\\d+\\]?\\.?)/);
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i].trim();
      if (!block) continue;
      var titleMatch = block.match(/####\\s*\\[?(\\d+)\\]?\\.?\\s*(.+?)(?:\\s*—|$)/m);
      var fileMatch = block.match(/\\*\\*File:\\*\\*\\s*\`([^\`]+)\`\\s*L?(\\d+)?/);
      if (titleMatch) {
        findings.push({
          id: (titleMatch[1] || i).toString(),
          title: titleMatch[2] ? titleMatch[2].trim() : 'Finding ' + i,
          file: fileMatch ? fileMatch[1] : '',
          line: fileMatch && fileMatch[2] ? parseInt(fileMatch[2]) : 0,
          raw: block,
        });
      }
    }
    return findings;
  }

  function buildComparison(review) {
    var panel = document.getElementById('compare-panel');
    if (!panel) return;
    panel.innerHTML = '';

    var models = Object.keys(review.results).filter(function(m) {
      return review.results[m].success;
    });
    if (models.length < 2) {
      panel.innerHTML = '<p class="empty-state">Need 2+ successful models to compare.</p>';
      return;
    }

    // Parse findings per model
    var modelFindings = {};
    models.forEach(function(m) { modelFindings[m] = parseFindings(review.results[m].output); });

    // Match findings across models by file+line proximity
    var allFindings = [];
    models.forEach(function(m) {
      modelFindings[m].forEach(function(f) {
        allFindings.push({ model: m, finding: f });
      });
    });

    // Group by file reference (findings about the same file within 5 lines)
    var groups = [];
    var used = new Set();
    for (var i = 0; i < allFindings.length; i++) {
      if (used.has(i)) continue;
      var group = [allFindings[i]];
      used.add(i);
      if (allFindings[i].finding.file) {
        for (var j = i + 1; j < allFindings.length; j++) {
          if (used.has(j)) continue;
          if (allFindings[j].finding.file === allFindings[i].finding.file &&
              allFindings[j].model !== allFindings[i].model &&
              Math.abs(allFindings[j].finding.line - allFindings[i].finding.line) <= 5) {
            group.push(allFindings[j]);
            used.add(j);
          }
        }
      }
      groups.push(group);
    }

    // Build consensus summary
    var consensus = groups.filter(function(g) { return g.length >= 2; });
    var unique = groups.filter(function(g) { return g.length === 1; });

    var summaryDiv = document.createElement('div');
    summaryDiv.className = 'consensus-summary';

    if (consensus.length > 0) {
      var h3c = document.createElement('h3');
      h3c.innerHTML = '<span class="finding-tag consensus">' + consensus.length + '</span> Consensus Issues';
      summaryDiv.appendChild(h3c);
      consensus.forEach(function(g) {
        var item = document.createElement('div');
        item.className = 'consensus-item';
        var modelsInGroup = g.map(function(e) { return e.model; }).join(', ');
        item.textContent = g[0].finding.title + ' (' + modelsInGroup + ')';
        if (g[0].finding.file) item.textContent += ' — ' + g[0].finding.file;
        summaryDiv.appendChild(item);
      });
    }

    if (unique.length > 0) {
      var h3u = document.createElement('h3');
      h3u.innerHTML = '<span class="finding-tag unique">' + unique.length + '</span> Unique Findings';
      summaryDiv.appendChild(h3u);
      unique.forEach(function(g) {
        var item = document.createElement('div');
        item.className = 'unique-item';
        item.textContent = g[0].finding.title + ' (only ' + g[0].model + ')';
        if (g[0].finding.file) item.textContent += ' — ' + g[0].finding.file;
        summaryDiv.appendChild(item);
      });
    }

    panel.appendChild(summaryDiv);

    // Tabbed model outputs
    var tabBar = document.createElement('div');
    tabBar.className = 'compare-tabs';
    var contentDiv = document.createElement('div');
    contentDiv.className = 'compare-content';

    models.forEach(function(m, idx) {
      var tab = document.createElement('button');
      tab.textContent = m;
      var stat = MODEL_STATS.find(function(s) { return s.model === m; });
      if (stat) {
        var avg = stat.avgScore.toFixed(1);
        tab.textContent = m + ' (' + avg + ')';
      }
      if (idx === 0) tab.classList.add('active');
      tab.onclick = function() {
        tabBar.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); });
        tab.classList.add('active');
        contentDiv.querySelectorAll('pre').forEach(function(p) { p.classList.add('hidden'); });
        document.getElementById('compare-output-' + m).classList.remove('hidden');
      };
      tabBar.appendChild(tab);

      var pre = document.createElement('pre');
      pre.id = 'compare-output-' + m;
      pre.textContent = review.results[m].output;
      if (idx !== 0) pre.classList.add('hidden');
      contentDiv.appendChild(pre);
    });

    panel.appendChild(tabBar);
    panel.appendChild(contentDiv);
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

  // ─── History ───
  function renderHistory() {
    var list = document.getElementById('history-list');
    if (!reviewHistory.length) {
      list.innerHTML = '<p class="empty-state">No past reviews.</p>';
      return;
    }
    list.innerHTML = '';
    reviewHistory.forEach(function(r) {
      var item = document.createElement('div');
      item.className = 'history-item';
      var titleSpan = document.createElement('span');
      titleSpan.className = 'history-title';
      var prBadge = document.createElement('span');
      prBadge.className = 'history-pr';
      prBadge.textContent = '#' + r.prNumber;
      titleSpan.appendChild(prBadge);
      titleSpan.appendChild(document.createTextNode(' ' + r.prTitle));
      var dateSpan = document.createElement('span');
      dateSpan.className = 'history-date';
      dateSpan.textContent = new Date(r.timestamp).toLocaleDateString();
      item.appendChild(titleSpan);
      item.appendChild(dateSpan);
      item.onclick = function() {
        currentReview = r;
        isViewingHistory = true;
        renderResults(r);
      };
      list.appendChild(item);
    });
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
      case 'reviewChunk': {
        if (!chunkBuffers[msg.model]) chunkBuffers[msg.model] = '';
        chunkBuffers[msg.model] += msg.text;
        if (chunkBuffers[msg.model].length > 4096) {
          chunkBuffers[msg.model] = chunkBuffers[msg.model].slice(-4096);
        }
        var preview = document.getElementById('chunks-' + msg.model);
        if (preview) {
          var lines = chunkBuffers[msg.model].split('\\n');
          preview.textContent = lines.slice(-3).join('\\n');
          preview.classList.add('active');
        }
        break;
      }
      case 'reviewComplete': stopElapsedTimer(); modelStartTimes = {}; isViewingHistory = false; currentReview = msg.review; renderResults(msg.review); break;
      case 'reviewError':
        stopElapsedTimer(); modelStartTimes = {};
        showState('select');
        document.getElementById('pr-error').textContent = msg.error;
        document.getElementById('pr-error').classList.remove('hidden');
        break;
      case 'leaderboard': renderLeaderboard(msg.stats); break;
      case 'modelHealth':
        Object.keys(msg.health).forEach(function(m) {
          var dot = document.querySelector('.health-dot[data-model="' + m + '"]');
          if (dot) {
            dot.className = 'health-dot ' + (msg.health[m] ? 'available' : 'unavailable');
            dot.title = msg.health[m] ? m + ' is available' : m + ' not found';
          }
        });
        break;
      case 'reviewHistory':
        reviewHistory = msg.reviews;
        renderHistory();
        break;
      case 'gradePromptReady': {
        var promptBlock = document.getElementById('grade-prompt-block');
        var promptText = document.getElementById('grade-prompt-text');
        if (promptBlock && promptText) {
          promptText.textContent = msg.prompt;
          promptBlock.classList.remove('hidden');
        }
        break;
      }
      case 'error':
        showPrError(msg.message, 'Failed to load PRs');
        break;
    }
  });

  ${ESCAPE_HTML_JS}

  // Defer init so the VS Code webview message bridge is ready
  setTimeout(init, 50);
</script>
</body>
</html>`;
  }
}
