import * as fs from 'fs';
import * as path from 'path';

import {
  ModelStats,
  ReviewRecord,
  ScoreEntry,
} from '../types';
import { Config } from '../config';

export class ScoreStore {
  private reviewsCache: ReviewRecord[] | null = null;
  private scoresCache: ScoreEntry[] | null = null;

  private get dir(): string {
    return Config.dataDir;
  }

  private get reviewsPath(): string {
    return path.join(this.dir, 'reviews.json');
  }

  private get scoresPath(): string {
    return path.join(this.dir, 'scores.json');
  }

  get lastReviewPath(): string {
    return path.join(this.dir, 'last-review.json');
  }

  get pendingScoresPath(): string {
    return path.join(this.dir, 'pending-scores.json');
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  invalidateCache(): void {
    this.reviewsCache = null;
    this.scoresCache = null;
  }

  // --- Reviews ---

  saveReview(review: ReviewRecord): void {
    this.ensureDir();
    const reviews = this.loadReviews();
    const idx = reviews.findIndex((r) => r.id === review.id);
    if (idx >= 0) {
      reviews[idx] = review;
    } else {
      reviews.push(review);
    }
    fs.writeFileSync(this.reviewsPath, JSON.stringify(reviews, null, 2));
    this.reviewsCache = reviews;
  }

  loadReviews(): ReviewRecord[] {
    if (this.reviewsCache !== null) {
      return this.reviewsCache;
    }
    try {
      const raw = fs.readFileSync(this.reviewsPath, 'utf-8');
      this.reviewsCache = JSON.parse(raw);
      return this.reviewsCache!;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.reviewsCache = [];
        return this.reviewsCache;
      }
      console.warn(`Fleet Review: failed to read ${this.reviewsPath}: ${err}`);
      return [];
    }
  }

  getReview(id: string): ReviewRecord | undefined {
    return this.loadReviews().find((r) => r.id === id);
  }

  getLatestReview(): ReviewRecord | undefined {
    const reviews = this.loadReviews();
    return reviews[reviews.length - 1];
  }

  // --- Scores ---

  saveScore(entry: ScoreEntry): void {
    this.ensureDir();
    const scores = this.loadScores();
    scores.push(entry);
    fs.writeFileSync(this.scoresPath, JSON.stringify(scores, null, 2));
    this.scoresCache = scores;
  }

  saveScores(entries: ScoreEntry[]): void {
    this.ensureDir();
    const scores = this.loadScores();
    scores.push(...entries);
    fs.writeFileSync(this.scoresPath, JSON.stringify(scores, null, 2));
    this.scoresCache = scores;
  }

  loadScores(): ScoreEntry[] {
    if (this.scoresCache !== null) {
      return this.scoresCache;
    }
    try {
      const raw = fs.readFileSync(this.scoresPath, 'utf-8');
      this.scoresCache = JSON.parse(raw);
      return this.scoresCache!;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.scoresCache = [];
        return this.scoresCache;
      }
      console.warn(`Fleet Review: failed to read ${this.scoresPath}: ${err}`);
      return [];
    }
  }

  getScoresForReview(reviewId: string): ScoreEntry[] {
    return this.loadScores().filter((s) => s.reviewId === reviewId);
  }

  // --- Stats ---

  getModelStats(timeframe: 'week' | 'month' | 'all' = 'all'): ModelStats[] {
    const scores = this.loadScores();
    const now = Date.now();
    const cutoff =
      timeframe === 'week'
        ? now - 7 * 24 * 60 * 60 * 1000
        : timeframe === 'month'
          ? now - 30 * 24 * 60 * 60 * 1000
          : 0;

    const filtered = scores.filter(
      (s) => new Date(s.timestamp).getTime() >= cutoff
    );

    const byModel = new Map<string, number[]>();
    for (const s of filtered) {
      const arr = byModel.get(s.model) ?? [];
      arr.push(s.score);
      byModel.set(s.model, arr);
    }

    const stats: ModelStats[] = [];
    for (const [model, modelScores] of byModel) {
      const sorted = [...modelScores].sort((a, b) => a - b);
      stats.push({
        model,
        avgScore: modelScores.reduce((a, b) => a + b, 0) / modelScores.length,
        totalReviews: modelScores.length,
        best: sorted[sorted.length - 1],
        worst: sorted[0],
        recentScores: modelScores.slice(-20),
      });
    }

    return stats.sort((a, b) => b.avgScore - a.avgScore);
  }

  // --- Last review for Claude Code grading ---

  writeLastReview(review: ReviewRecord): void {
    this.ensureDir();
    const data = {
      reviewId: review.id,
      repo: review.repo,
      prNumber: review.prNumber,
      prTitle: review.prTitle,
      results: Object.fromEntries(
        Object.entries(review.results)
          .filter(([, r]) => r.success)
          .map(([model, r]) => [model, { output: r.output }])
      ),
    };
    fs.writeFileSync(this.lastReviewPath, JSON.stringify(data, null, 2));
  }

  // --- Pending scores from Claude Code ---

  readPendingScores(): ScoreEntry[] | null {
    try {
      const raw = fs.readFileSync(this.pendingScoresPath, 'utf-8');
      const data = JSON.parse(raw);

      // Canonical format: { reviewId, scores: [...] }
      if (data.reviewId && Array.isArray(data.scores)) {
        return data.scores.map(
          (s: { model: string; score: number; feedback: string }) => ({
            reviewId: data.reviewId,
            model: s.model,
            score: Math.max(1, Math.min(10, Math.round(s.score))),
            feedback: s.feedback ?? '',
            gradedBy: 'claude' as const,
            timestamp: new Date().toISOString(),
          })
        );
      }

      // Fallback: flat ScoreEntry array (reviewId on each item)
      if (Array.isArray(data) && data.length > 0 && data[0].reviewId && data[0].model) {
        return data.map((s: ScoreEntry) => ({
          reviewId: s.reviewId,
          model: s.model,
          score: Math.max(1, Math.min(10, Math.round(s.score))),
          feedback: s.feedback ?? '',
          gradedBy: 'claude' as const,
          timestamp: new Date().toISOString(),
        }));
      }

      return null;
    } catch {
      return null;
    }
  }

  deletePendingScores(): void {
    try {
      fs.unlinkSync(this.pendingScoresPath);
    } catch {
      // ignore
    }
  }
}
