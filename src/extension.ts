import * as vscode from "vscode";

import { GitHubClient } from "./github/GitHubClient";
import { ScoreStore } from "./scoring/ScoreStore";
import { GradeImporter } from "./scoring/GradeImporter";
import { SidebarProvider } from "./webview/SidebarProvider";
import { GradingPanel } from "./webview/GradingPanel";
import { LeaderboardPanel } from "./webview/LeaderboardPanel";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Fleet Review");
  output.appendLine(`[${new Date().toISOString()}] Extension activating`);

  const github = new GitHubClient(output);
  const store = new ScoreStore();
  const gradeImporter = new GradeImporter(store);

  store.ensureDir();
  gradeImporter.startWatching();

  // --- Sidebar webview ---

  const sidebarProvider = new SidebarProvider(context.extensionUri, github, store, output);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("fleetReview.sidebar", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    // Commands (also accessible from command palette)
    vscode.commands.registerCommand("fleetReview.startReview", () => {
      // Focus the sidebar — the UI lives there
      vscode.commands.executeCommand("fleetReview.sidebar.focus");
    }),

    vscode.commands.registerCommand("fleetReview.gradeReview", () => {
      try {
        GradingPanel.create(context.extensionUri, store);
      } catch {
        // Warning already shown by GradingPanel.create
      }
    }),

    vscode.commands.registerCommand("fleetReview.gradeWithClaude", async () => {
      try {
        const review = store.getLatestReview();
        if (!review) {
          vscode.window.showWarningMessage("Fleet Review: No review to grade");
          return;
        }

        await store.writeLastReview(review);
        vscode.window.showInformationMessage(
          `Fleet Review: Review data written to ${store.lastReviewPath}. ` +
            "Open Claude Code and ask it to grade the review and write scores to " +
            store.pendingScoresPath,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Fleet Review: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand("fleetReview.viewScores", () => {
      LeaderboardPanel.create(context.extensionUri, store);
    }),

    gradeImporter,
  );
}

export function deactivate() {
  // Cleanup handled by disposables
}
