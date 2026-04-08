export const MODEL_NAMES = ['claude', 'codex', 'gemini', 'qwen', 'copilot'] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

export type ModelStatus = 'pending' | 'running' | 'done' | 'failed' | 'timeout' | 'timeout-pending';

export type TimeoutDecision = 'extend' | 'kill';
export type ReviewStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PR {
  number: number;
  title: string;
  author: string;
  createdAt: string;
  headRefName: string;
  additions: number;
  deletions: number;
}

export interface PRDetail extends PR {
  body: string;
  files: string[];
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ProjectType =
  | 'android'
  | 'jvm'
  | 'node'
  | 'rust'
  | 'go'
  | 'python'
  | 'ruby'
  | 'unknown';

export interface ModelResult {
  model: ModelName;
  output: string;
  success: boolean;
  error?: string;
  postedToGitHub: boolean;
  durationMs: number;
}

export interface ReviewRecord {
  id: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  timestamp: string;
  models: ModelName[];
  results: Record<string, ModelResult>;
  mergedReport?: string;
}

export interface ScoreEntry {
  reviewId: string;
  model: string;
  score: number;
  feedback: string;
  gradedBy: 'user' | 'claude';
  timestamp: string;
}

export interface ModelStats {
  model: string;
  avgScore: number;
  totalReviews: number;
  best: number;
  worst: number;
  recentScores: number[];
}

export interface PendingScores {
  reviewId: string;
  scores: Array<{
    model: string;
    score: number;
    feedback: string;
  }>;
}

export interface ProgressUpdate {
  model: string;
  status: ModelStatus;
  durationMs?: number;
}

// Webview message types
export type WebviewMessage =
  | { type: 'requestPRs' }
  | { type: 'startReview'; models: ModelName[]; prNumber: number }
  | { type: 'cancelReview' }
  | { type: 'extendTimeout'; model: string }
  | { type: 'killModel'; model: string }
  | { type: 'submitGrades'; scores: Array<{ model: string; score: number; feedback: string }> }
  | { type: 'gradeWithClaude' }
  | { type: 'requestLeaderboard'; timeframe: 'week' | 'month' | 'all' }
  | { type: 'requestReviewHistory' };

export type ExtensionMessage =
  | { type: 'prs'; prs: PR[] }
  | { type: 'reviewProgress'; model: string; status: ModelStatus; durationMs?: number }
  | { type: 'reviewBytes'; model: string; bytes: number }
  | { type: 'reviewComplete'; review: ReviewRecord }
  | { type: 'reviewError'; error: string }
  | { type: 'leaderboard'; stats: ModelStats[] }
  | { type: 'reviewHistory'; reviews: ReviewRecord[] }
  | { type: 'gradesImported'; scores: ScoreEntry[] }
  | { type: 'error'; message: string };
