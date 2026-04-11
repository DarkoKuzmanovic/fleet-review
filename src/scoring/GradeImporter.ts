import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { ScoreEntry } from '../types';
import { ScoreStore } from './ScoreStore';

export class GradeImporter implements vscode.Disposable {
  private watcher: fs.FSWatcher | null = null;
  private readonly onImportEmitter = new vscode.EventEmitter<ScoreEntry[]>();
  public readonly onImport = this.onImportEmitter.event;

  constructor(private store: ScoreStore) {}

  startWatching(): void {
    this.stopWatching();

    const filePath = this.store.pendingScoresPath;

    // Ensure parent directory exists
    this.store.ensureDir();

    try {
      this.watcher = fs.watch(
        path.dirname(filePath),
        (eventType, filename) => {
          if (filename === 'pending-scores.json') {
            this.tryImport();
          }
        }
      );
    } catch {
      // Directory might not exist yet — that's fine
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private tryImport(): void {
    // Small delay to let the file finish writing
    setTimeout(async () => {
      try {
        this.store.invalidateCache();
        const scores = this.store.readPendingScores();
        if (!scores || scores.length === 0) {
          return;
        }

        // Verify the review exists
        const reviewId = scores[0].reviewId;
        const review = this.store.getReview(reviewId);
        if (!review) {
          vscode.window.showWarningMessage(
            `Fleet Review: pending scores reference unknown review ${reviewId}`
          );
          return;
        }

        // Import scores
        await this.store.saveScores(scores);
        this.store.deletePendingScores();
        this.onImportEmitter.fire(scores);

        const summary = scores
          .map((s) => `${s.model}=${s.score}`)
          .join(', ');
        vscode.window.showInformationMessage(
          `Fleet Review: Claude Code grades imported (${summary})`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Fleet Review: import failed — ${err instanceof Error ? err.message : err}`);
      }
    }, 500);
  }

  dispose(): void {
    this.stopWatching();
    this.onImportEmitter.dispose();
  }
}
