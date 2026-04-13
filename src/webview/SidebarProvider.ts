import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

import { ExtensionMessage, ModelName, TimeoutDecision, WebviewMessage } from "../types";
import { Config } from "../config";
import { GitHubClient } from "../github/GitHubClient";
import { CliDispatcher } from "../review/CliDispatcher";
import { PromptBuilder } from "../review/PromptBuilder";
import { ReviewOrchestrator } from "../review/ReviewOrchestrator";
import { ProviderRegistry } from "../review/providers/registry";
import { ScoreStore } from "../scoring/ScoreStore";
import { escapeHtml, safeJsonForHtml } from "./webviewUtils";

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private orchestrator: ReviewOrchestrator;
  private promptBuilder: PromptBuilder;
  private repo = "";
  private lastReview: import("../types").ReviewRecord | null = null;
  private pendingTimeouts = new Map<string, (decision: TimeoutDecision) => void>();

  private clearPendingTimeouts(): void {
    for (const resolve of this.pendingTimeouts.values()) {
      resolve("kill");
    }
    this.pendingTimeouts.clear();
  }

  constructor(
    private extensionUri: vscode.Uri,
    private github: GitHubClient,
    private store: ScoreStore,
    private registry: ProviderRegistry,
    private output: vscode.OutputChannel,
    private version: string = "",
  ) {
    this.promptBuilder = new PromptBuilder();
    this.orchestrator = new ReviewOrchestrator(
      github,
      new CliDispatcher(registry, output),
      this.promptBuilder,
      store,
      registry,
      output,
    );
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
    try {
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
          await this.gradeWithClaude();
          break;
        case "submitGrades":
          await this.submitGrades(msg.scores);
          break;
        case "requestLeaderboard":
          this.sendLeaderboard(msg.timeframe);
          break;
        case "retryModel":
          if (!this.registry.has(msg.model)) {
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
    } catch (err) {
      const msg2 = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Fleet Review: ${msg2}`);
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
      this.clearPendingTimeouts();
    }
  }

  private async gradeWithClaude(): Promise<void> {
    try {
      const review = this.store.getLatestReview();
      if (!review) {
        vscode.window.showWarningMessage("Fleet Review: No review to grade");
        return;
      }
      await this.store.writeLastReview(review);

      const models = Object.entries(review.results)
        .filter(([, r]) => r.success)
        .map(([m]) => m);

      const prompt = [
        `Read the review data from ${this.store.lastReviewPath}`,
        ``,
        `Grade each model (${models.join(", ")}) on a scale of 1-10 based on:`,
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
      ].join("\n");

      this.post({ type: "gradePromptReady", prompt });
    } catch (err) {
      vscode.window.showErrorMessage(`Fleet Review: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async submitGrades(scores: Array<{ model: string; score: number; feedback: string }>): Promise<void> {
    try {
      const review = this.store.getLatestReview();
      if (!review) return;

      if (!Array.isArray(scores)) {
        vscode.window.showErrorMessage("Fleet Review: invalid grade payload");
        return;
      }

      const knownModels = new Set(this.registry.list().map((p) => p.name));
      for (const s of scores) {
        if (!s || typeof s.model !== "string" || !knownModels.has(s.model)) {
          vscode.window.showErrorMessage(`Fleet Review: unknown model in grade payload`);
          return;
        }
        if (typeof s.score !== "number" || !Number.isFinite(s.score) || s.score < 1 || s.score > 10) {
          vscode.window.showErrorMessage(`Fleet Review: score for ${s.model} must be 1–10`);
          return;
        }
      }

      const entries = scores.map((s) => ({
        reviewId: review.id,
        model: s.model,
        score: Math.round(s.score),
        feedback: typeof s.feedback === "string" ? s.feedback : "",
        gradedBy: "user" as const,
        timestamp: new Date().toISOString(),
      }));

      await this.store.saveScores(entries);
      vscode.window.showInformationMessage(`Fleet Review: Grades saved for ${entries.length} models`);
      this.post({ type: "gradesImported", scores: entries });
    } catch (err) {
      vscode.window.showErrorMessage(`Fleet Review: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sendLeaderboard(timeframe: "week" | "month" | "all"): void {
    try {
      const stats = this.store.getModelStats(timeframe);
      this.post({ type: "leaderboard", stats });
    } catch (err) {
      vscode.window.showErrorMessage(`Fleet Review: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async checkModelHealth(): Promise<void> {
    const execFileAsync = promisify(execFile);
    const health: Record<string, boolean> = Object.create(null);

    for (const provider of this.registry.list()) {
      if (provider.kind === "cli") {
        try {
          await execFileAsync(process.platform === "win32" ? "where" : "which", [provider.command]);
          health[provider.name] = true;
        } catch {
          health[provider.name] = false;
        }
      } else {
        const apiKey = await this.registry.getGatewayApiKey(provider.gateway);
        health[provider.name] = !!apiKey;
      }
    }

    this.post({ type: "modelHealth", health });
  }

  private async retryModelCore(model: ModelName, sharedController?: AbortController): Promise<void> {
    if (!this.lastReview) {
      throw new Error("No review to retry");
    }

    const updated = await this.orchestrator.retrySingleModel(
      model,
      this.lastReview,
      (m, status) => this.post({ type: "reviewProgress", model: m, status }),
      (m, bytes) => this.post({ type: "reviewBytes", model: m, bytes }),
      (m) =>
        new Promise<TimeoutDecision>((resolve) => {
          this.pendingTimeouts.set(m, resolve);
        }),
      (m, text) => this.post({ type: "reviewChunk", model: m, text }),
      sharedController,
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
      this.clearPendingTimeouts();
    }
  }

  private async retryAllFailed(): Promise<void> {
    if (!this.lastReview) return;

    const failedModels = Object.entries(this.lastReview.results)
      .filter(([, r]) => !r.success)
      .map(([m]) => m as ModelName);

    if (failedModels.length === 0) return;

    const availableModels = failedModels.filter((m) => this.registry.has(m));
    if (availableModels.length === 0) {
      vscode.window.showWarningMessage("Fleet Review: No available models to retry");
      return;
    }

    const sharedController = new AbortController();

    try {
      const results = await Promise.allSettled(
        availableModels.map((model) => this.retryModelCore(model, sharedController)),
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      const fulfilled = results.filter((r): r is PromiseFulfilledResult<void> => r.status === "fulfilled");

      if (rejected.length && fulfilled.length === 0) {
        const first = rejected[0].reason;
        this.post({ type: "reviewError", error: first instanceof Error ? first.message : String(first) });
        return;
      }
      if (rejected.length > 0 && fulfilled.length > 0) {
        vscode.window.showWarningMessage(
          `Fleet Review: ${rejected.length} of ${results.length} retries failed`,
        );
      }
      if (this.lastReview) {
        this.post({ type: "reviewComplete", review: this.lastReview });
      }
    } finally {
      this.clearPendingTimeouts();
    }
  }

  private post(msg: ExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(): string {
    const providerList = this.registry.list().map((p) => ({
      name: p.name,
      displayName: p.displayName,
      kind: p.kind,
    }));
    const modelTimeouts: Record<string, number> = {};
    for (const p of this.registry.list()) {
      modelTimeouts[p.name] = Math.round(p.defaultTimeoutMs / 1000);
    }
    const providersJson = safeJsonForHtml(providerList);
    const modelsJson = safeJsonForHtml(providerList.map((p) => p.name));
    const defaultsJson = safeJsonForHtml(Config.defaultModels);
    const timeoutSec = safeJsonForHtml(Number(Config.timeoutMs / 1000));
    const modelTimeoutsJson = safeJsonForHtml(modelTimeouts);
    const apiModelsJson = safeJsonForHtml(providerList.filter((p) => p.kind === "http").map((p) => p.name));
    const diffSizeThreshold = safeJsonForHtml(Number(Config.diffSizeWarningThreshold));
    let stats;
    try {
      stats = this.store.getModelStats("all");
    } catch {
      stats = new Map();
    }
    const modelStatsJson = safeJsonForHtml(stats);
    const webview = this.view!.webview;
    const cliIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "cli.svg"));
    const apiIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "api.svg"));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.js"));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource};">
<link rel="stylesheet" href="${cssUri}">
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
  window.__FR_CONFIG = {
    providers: ${providersJson},
    models: ${modelsJson},
    defaults: ${defaultsJson},
    timeoutSec: ${timeoutSec},
    modelTimeouts: ${modelTimeoutsJson},
    apiModels: ${apiModelsJson},
    diffSizeThreshold: ${diffSizeThreshold},
    modelStats: ${modelStatsJson},
    cliIconUri: ${safeJsonForHtml(cliIconUri.toString())},
    apiIconUri: ${safeJsonForHtml(apiIconUri.toString())},
  };
</script>
<script src="${jsUri}"></script>
<footer class="sidebar-footer">v${escapeHtml(this.version)}</footer>
</body>
</html>`;
  }
}
