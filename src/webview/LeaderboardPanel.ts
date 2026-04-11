import * as vscode from 'vscode';

import { ExtensionMessage, ModelStats, WebviewMessage } from '../types';
import { ScoreStore } from '../scoring/ScoreStore';

export class LeaderboardPanel {
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static create(extensionUri: vscode.Uri, store: ScoreStore): LeaderboardPanel {
    const panel = vscode.window.createWebviewPanel(
      'fleetReview.leaderboard',
      'Fleet Review: Leaderboard',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    return new LeaderboardPanel(panel, store);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private store: ScoreStore
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Send initial data
    this.sendStats('all');
  }

  private handleMessage(msg: WebviewMessage): void {
    if (msg.type === 'requestLeaderboard') {
      this.sendStats(msg.timeframe);
    }
  }

  private sendStats(timeframe: 'week' | 'month' | 'all'): void {
    try {
      const stats = this.store.getModelStats(timeframe);
      const response: ExtensionMessage = { type: 'leaderboard', stats };
      this.panel.webview.postMessage(response);
    } catch (err) {
      vscode.window.showErrorMessage(`Fleet Review: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private getHtml(): string {
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
    --desc-fg: var(--vscode-descriptionForeground);
    --list-hover: var(--vscode-list-hoverBackground);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); padding: 24px; font-size: 13px; line-height: 1.4; }
  h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
    color: var(--desc-fg); margin-bottom: 16px;
  }

  .filters { display: flex; gap: 4px; margin-bottom: 16px; }
  .filters button {
    padding: 4px 14px; background: transparent; color: var(--desc-fg);
    border: 1px solid var(--border); border-radius: 12px; cursor: pointer; font-size: 12px;
    font-family: var(--vscode-font-family); transition: all 0.1s;
  }
  .filters button:hover { color: var(--fg); border-color: var(--fg); }
  .filters button.active { background: var(--btn-bg); color: var(--btn-fg); border-color: var(--btn-bg); }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th {
    text-align: left; padding: 8px 10px; font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.5px; color: var(--desc-fg);
    border-bottom: 1px solid var(--border);
  }
  td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: var(--list-hover); }

  .model-name { font-weight: 600; }
  .score { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .score.high { color: var(--vscode-testing-iconPassed); }
  .score.mid { color: var(--vscode-editorWarning-foreground); }
  .score.low { color: var(--vscode-testing-iconFailed); }

  .sparkline { display: inline-block; vertical-align: middle; }
  .sparkline svg { display: block; }

  .empty { text-align: center; padding: 48px; color: var(--desc-fg); font-size: 13px; }
</style>
</head>
<body>
<h2>Model Leaderboard</h2>

<div class="filters">
  <button data-tf="week">Week</button>
  <button data-tf="month">Month</button>
  <button data-tf="all" class="active">All Time</button>
</div>

<div id="content">
  <div class="empty">No scores yet. Run a review and grade the models to see stats here.</div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let currentTf = 'all';

  document.querySelectorAll('.filters button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTf = btn.dataset.tf;
      vscode.postMessage({ type: 'requestLeaderboard', timeframe: currentTf });
    };
  });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'leaderboard') {
      renderLeaderboard(msg.stats);
    }
  });

  function renderLeaderboard(stats) {
    const el = document.getElementById('content');

    if (!stats.length) {
      el.innerHTML = '<div class="empty">No scores for this timeframe.</div>';
      return;
    }

    let html = '<table><thead><tr>' +
      '<th>Model</th><th>Avg Score</th><th>Reviews</th><th>Best</th><th>Worst</th><th>Trend</th>' +
      '</tr></thead><tbody>';

    for (const s of stats) {
      const avg = s.avgScore.toFixed(1);
      const cls = s.avgScore >= 7 ? 'high' : s.avgScore >= 5 ? 'mid' : 'low';
      const sparkline = buildSparkline(s.recentScores, 80, 24);

      html += '<tr>' +
        '<td class="model-name">' + s.model + '</td>' +
        '<td><span class="score ' + cls + '">' + avg + '</span></td>' +
        '<td>' + s.totalReviews + '</td>' +
        '<td>' + s.best + '</td>' +
        '<td>' + s.worst + '</td>' +
        '<td class="sparkline">' + sparkline + '</td>' +
        '</tr>';
    }

    html += '</tbody></table>';
    el.innerHTML = html;
  }

  function buildSparkline(scores, width, height) {
    if (!scores || scores.length < 2) {
      return '<span style="opacity:0.3;font-size:11px">—</span>';
    }

    const min = 1;
    const max = 10;
    const padding = 2;
    const w = width - padding * 2;
    const h = height - padding * 2;

    const points = scores.map((val, i) => {
      const x = padding + (i / (scores.length - 1)) * w;
      const y = padding + h - ((val - min) / (max - min)) * h;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    const last = scores[scores.length - 1];
    const color = last >= 7 ? 'var(--vscode-testing-iconPassed)' : last >= 5 ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-testing-iconFailed)';

    return '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
      '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      '</svg>';
  }
</script>
</body>
</html>`;
  }
}
