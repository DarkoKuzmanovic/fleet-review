import * as vscode from "vscode";

import { Config } from "./config";
import { GitHubClient } from "./github/GitHubClient";
import { ScoreStore } from "./scoring/ScoreStore";
import { GradeImporter } from "./scoring/GradeImporter";
import { SidebarProvider } from "./webview/SidebarProvider";
import { GradingPanel } from "./webview/GradingPanel";
import { LeaderboardPanel } from "./webview/LeaderboardPanel";
import { ProviderRegistry } from "./review/providers/registry";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Fleet Review");
  output.appendLine(`[${new Date().toISOString()}] Extension activating`);

  const github = new GitHubClient(output);
  const store = new ScoreStore();
  const gradeImporter = new GradeImporter(store);

  const registry = new ProviderRegistry({
    defaultTimeoutMs: Config.timeoutMs,
    customProviders: Config.customProviders,
    customGateways: Config.customGateways,
    secrets: context.secrets,
    log: (m) => output.appendLine(`[registry] ${m}`),
  });

  store.ensureDir();
  gradeImporter.startWatching();

  // --- Sidebar webview ---

  const sidebarProvider = new SidebarProvider(context.extensionUri, github, store, registry, output);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("fleetReview.sidebar", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("fleetReview.startReview", () => {
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

    vscode.commands.registerCommand("fleetReview.setGatewayApiKey", async () => {
      const gateways = registry.listGateways();
      if (gateways.length === 0) {
        vscode.window.showWarningMessage("Fleet Review: no HTTP gateways registered");
        return;
      }

      const picked = await vscode.window.showQuickPick(
        gateways.map((g) => ({ label: g.name, description: g.baseUrl })),
        { placeHolder: "Select a gateway" },
      );
      if (!picked) return;

      const key = await vscode.window.showInputBox({
        prompt: `API key for ${picked.label}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;

      if (key === "") {
        await registry.deleteGatewayApiKey(picked.label);
        vscode.window.showInformationMessage(`Fleet Review: removed API key for ${picked.label}`);
      } else {
        await registry.setGatewayApiKey(picked.label, key);
        vscode.window.showInformationMessage(`Fleet Review: API key saved for ${picked.label}`);
      }
    }),

    gradeImporter,
  );
}

export function deactivate() {
  // Cleanup handled by disposables
}
