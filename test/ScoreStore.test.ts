import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode');

vi.mock('../src/config', () => ({
  Config: {
    dataDir: '/tmp/fleet-review-test',
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
    unlinkSync: vi.fn(),
    promises: {
      ...actual.promises,
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
    },
  };
});

import * as fs from 'fs';
import { ScoreStore } from '../src/scoring/ScoreStore';
import { ReviewRecord, ScoreEntry } from '../src/types';

const makeReview = (id: string): ReviewRecord => ({
  id,
  repo: 'owner/repo',
  prNumber: 1,
  prTitle: 'Test PR',
  timestamp: new Date().toISOString(),
  models: ['claude'],
  results: {},
});

const makeScore = (model: string, score: number, reviewId = 'r1', timestamp?: string): ScoreEntry => ({
  reviewId,
  model,
  score,
  feedback: 'good',
  gradedBy: 'user',
  timestamp: timestamp ?? new Date().toISOString(),
});

describe('ScoreStore.loadReviews', () => {
  let store: ScoreStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ScoreStore();
  });

  it('returns empty array when file does not exist (ENOENT)', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw err; });
    expect(store.loadReviews()).toEqual([]);
  });

  it('throws on non-ENOENT errors', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw err; });
    expect(() => store.loadReviews()).toThrow('Failed to load');
  });

  it('parses and returns valid JSON array', () => {
    const reviews = [makeReview('r1'), makeReview('r2')];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(reviews) as any);
    expect(store.loadReviews()).toEqual(reviews);
  });
});

describe('ScoreStore.saveReview', () => {
  let store: ScoreStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ScoreStore();
  });

  it('writes updated reviews to disk and caches result', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('[]' as any);
    const mockWrite = vi.mocked(fs.promises.writeFile);

    const review = makeReview('r1');
    await store.saveReview(review);

    expect(mockWrite).toHaveBeenCalledOnce();
    const [, content] = mockWrite.mock.calls[0] as [string, string, ...any[]];
    const written = JSON.parse(content);
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('r1');

    // Cache should be updated — readFileSync won't be called again
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('should not read'); });
    expect(store.loadReviews()[0].id).toBe('r1');
  });

  it('updates existing review rather than duplicating it', async () => {
    const review = makeReview('r1');
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([review]) as any);
    const mockWrite = vi.mocked(fs.promises.writeFile);

    const updated = { ...review, prTitle: 'Updated Title' };
    await store.saveReview(updated);

    const [, content] = mockWrite.mock.calls[0] as [string, string, ...any[]];
    const written = JSON.parse(content);
    expect(written).toHaveLength(1);
    expect(written[0].prTitle).toBe('Updated Title');
  });
});

describe('ScoreStore.loadScores', () => {
  let store: ScoreStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ScoreStore();
  });

  it('returns empty array when file does not exist (ENOENT)', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw err; });
    expect(store.loadScores()).toEqual([]);
  });

  it('throws on non-ENOENT errors', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw err; });
    expect(() => store.loadScores()).toThrow('Failed to load');
  });

  it('parses and returns valid JSON array', () => {
    const scores = [makeScore('claude', 8), makeScore('gemini', 7)];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(scores) as any);
    expect(store.loadScores()).toEqual(scores);
  });
});

describe('ScoreStore.getModelStats', () => {
  let store: ScoreStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ScoreStore();
  });

  it('computes correct avg, best, and worst', () => {
    const scores = [
      makeScore('claude', 6),
      makeScore('claude', 8),
      makeScore('claude', 10),
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(scores) as any);
    const stats = store.getModelStats('all');
    const claude = stats.find((s) => s.model === 'claude')!;
    expect(claude.avgScore).toBeCloseTo(8);
    expect(claude.best).toBe(10);
    expect(claude.worst).toBe(6);
    expect(claude.totalReviews).toBe(3);
  });

  it('filters by week timeframe', () => {
    const now = Date.now();
    const scores = [
      makeScore('claude', 9, 'r1', new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()),  // 2 days ago
      makeScore('claude', 3, 'r2', new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString()), // 10 days ago
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(scores) as any);
    const stats = store.getModelStats('week');
    const claude = stats.find((s) => s.model === 'claude')!;
    expect(claude.totalReviews).toBe(1);
    expect(claude.avgScore).toBe(9);
  });

  it('filters by month timeframe', () => {
    const now = Date.now();
    const scores = [
      makeScore('gemini', 7, 'r1', new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString()), // 15 days ago
      makeScore('gemini', 2, 'r2', new Date(now - 35 * 24 * 60 * 60 * 1000).toISOString()), // 35 days ago
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(scores) as any);
    const stats = store.getModelStats('month');
    const gemini = stats.find((s) => s.model === 'gemini')!;
    expect(gemini.totalReviews).toBe(1);
    expect(gemini.avgScore).toBe(7);
  });

  it('returns models sorted by avgScore descending', () => {
    const scores = [
      makeScore('claude', 5),
      makeScore('gemini', 9),
      makeScore('qwen', 7),
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(scores) as any);
    const stats = store.getModelStats('all');
    expect(stats[0].model).toBe('gemini');
    expect(stats[1].model).toBe('qwen');
    expect(stats[2].model).toBe('claude');
  });
});

describe('ScoreStore.readPendingScores', () => {
  let store: ScoreStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ScoreStore();
  });

  it('parses canonical format { reviewId, scores: [...] }', () => {
    const data = {
      reviewId: 'rev-123',
      scores: [
        { model: 'claude', score: 8, feedback: 'solid review' },
        { model: 'gemini', score: 7, feedback: 'decent' },
      ],
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data) as any);
    const result = store.readPendingScores();
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].reviewId).toBe('rev-123');
    expect(result![0].model).toBe('claude');
    expect(result![0].score).toBe(8);
    expect(result![0].gradedBy).toBe('claude');
  });

  it('clamps scores below 1 to 1', () => {
    const data = {
      reviewId: 'r1',
      scores: [{ model: 'claude', score: -5, feedback: '' }],
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data) as any);
    const result = store.readPendingScores();
    expect(result![0].score).toBe(1);
  });

  it('clamps scores above 10 to 10', () => {
    const data = {
      reviewId: 'r1',
      scores: [{ model: 'claude', score: 99, feedback: '' }],
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data) as any);
    const result = store.readPendingScores();
    expect(result![0].score).toBe(10);
  });

  it('returns null on invalid format (no reviewId)', () => {
    const data = { notReviewId: 'x', scores: [] };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data) as any);
    expect(store.readPendingScores()).toBeNull();
  });

  it('returns null when file does not exist', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    expect(store.readPendingScores()).toBeNull();
  });

  it('parses fallback flat ScoreEntry array format', () => {
    const data = [
      { reviewId: 'r1', model: 'claude', score: 8, feedback: 'ok', gradedBy: 'user', timestamp: '' },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data) as any);
    const result = store.readPendingScores();
    expect(result).not.toBeNull();
    expect(result![0].reviewId).toBe('r1');
    expect(result![0].model).toBe('claude');
    expect(result![0].gradedBy).toBe('claude');
  });
});
