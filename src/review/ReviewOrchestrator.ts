import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

import {
  ModelName,
  ModelResult,
  ModelStatus,
  PRDetail,
  ProjectType,
  ReviewRecord,
  TimeoutDecision,
} from '../types';
import { Config } from '../config';
import { CliDispatcher } from './CliDispatcher';
import { PromptBuilder } from './PromptBuilder';
import { GitHubClient } from '../github/GitHubClient';
import { ScoreStore } from '../scoring/ScoreStore';

export class ReviewOrchestrator {
  private abortController: AbortController | null = null;
  private lastPrompt = '';
  private lastRepo = '';
  private lastPrNumber = 0;

  constructor(
    private github: GitHubClient,
    private dispatcher: CliDispatcher,
    private promptBuilder: PromptBuilder,
    private store: ScoreStore,
    private output?: vscode.OutputChannel
  ) {}

  get isRunning(): boolean {
    return this.abortController !== null;
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async runReview(
    repo: string,
    pr: PRDetail,
    diff: string,
    models: ModelName[],
    projectType: ProjectType,
    onProgress: (model: string, status: ModelStatus) => void,
    onBytes?: (model: string, bytes: number) => void,
    onTimeout?: (model: string) => Promise<TimeoutDecision>,
    onText?: (model: string, text: string) => void
  ): Promise<ReviewRecord> {
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const prompt = this.promptBuilder.buildAuditPrompt(pr, diff, projectType);
    this.lastPrompt = prompt;
    this.lastRepo = repo;
    this.lastPrNumber = pr.number;

    // Dispatch all models in parallel
    const settled = await Promise.allSettled(
      models.map(async (model): Promise<ModelResult> => {
        onProgress(model, 'running');
        const startTime = Date.now();

        try {
          const onModelTimeout = onTimeout ? async () => {
            onProgress(model, 'timeout-pending');
            const decision = await onTimeout(model);
            if (decision === 'extend') {
              onProgress(model, 'running');
            }
            return decision;
          } : undefined;
          const modelTimeoutMs = Config.timeoutMsForModel(model);
          const result = await this.dispatcher.dispatch(model, prompt, onBytes ? (bytes) => onBytes(model, bytes) : undefined, signal, onModelTimeout, modelTimeoutMs, onText ? (text) => onText(model, text) : undefined);
          const durationMs = Date.now() - startTime;

          const success = result.exitCode === 0 && result.stdout.trim().length > 0;
          const status: ModelStatus = success ? 'done' : 'failed';
          onProgress(model, status);

          // Post to GitHub immediately on success
          let postedToGitHub = false;
          if (success && !signal.aborted) {
            try {
              const comment = `## Audit by \`${model}\`\n\n${result.stdout}\n\n---\n_Automated audit via Fleet Review_`;
              await this.github.postComment(repo, pr.number, comment);
              postedToGitHub = true;
            } catch {
              // Comment posting is best-effort
            }
          }

          return {
            model,
            output: result.stdout,
            success,
            error: success ? undefined : result.stderr || 'Empty output',
            postedToGitHub,
            durationMs,
          };
        } catch (err) {
          const durationMs = Date.now() - startTime;
          const message = err instanceof Error ? err.message : String(err);
          const status: ModelStatus = message.includes('timed out')
            ? 'timeout'
            : 'failed';
          onProgress(model, status);

          return {
            model,
            output: '',
            success: false,
            error: message,
            postedToGitHub: false,
            durationMs,
          };
        }
      })
    );

    // Collect results
    const results: Record<string, ModelResult> = {};
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        results[entry.value.model] = entry.value;
      }
    }

    this.abortController = null;

    // Build and save review record
    const review: ReviewRecord = {
      id: randomUUID(),
      repo,
      prNumber: pr.number,
      prTitle: pr.title,
      timestamp: new Date().toISOString(),
      models,
      results,
    };

    this.store.saveReview(review);
    return review;
  }

  async runMerge(
    repo: string,
    prNumber: number,
    review: ReviewRecord,
    diff: string
  ): Promise<string> {
    const auditOutputs: Record<string, string> = {};
    for (const [model, result] of Object.entries(review.results)) {
      if (result.success) {
        auditOutputs[model] = result.output;
      }
    }

    if (Object.keys(auditOutputs).length === 0) {
      throw new Error('No successful audits to merge');
    }

    const mergePrompt = this.promptBuilder.buildMergePrompt(auditOutputs, diff);
    const result = await this.dispatcher.dispatch('claude', mergePrompt);

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`Merge synthesis failed: ${result.stderr}`);
    }

    // Post merged report
    const comment = `## Merged Audit Report\n\n${result.stdout}\n\n---\n_Consolidated from independent audits via Fleet Review_`;
    try {
      await this.github.postComment(repo, prNumber, comment);
    } catch (e) {
      this.output?.appendLine(`Fleet Review: failed to post merged report: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Update review record
    review.mergedReport = result.stdout;
    this.store.saveReview(review);

    return result.stdout;
  }

  async retrySingleModel(
    model: ModelName,
    review: ReviewRecord,
    onProgress: (model: string, status: ModelStatus) => void,
    onBytes?: (model: string, bytes: number) => void,
    onTimeout?: (model: string) => Promise<TimeoutDecision>
  ): Promise<ReviewRecord> {
    if (!this.lastPrompt) {
      throw new Error('No previous review prompt available for retry');
    }

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    onProgress(model, 'running');
    const startTime = Date.now();

    try {
      const onModelTimeout = onTimeout ? async () => {
        onProgress(model, 'timeout-pending');
        const decision = await onTimeout(model);
        if (decision === 'extend') {
          onProgress(model, 'running');
        }
        return decision;
      } : undefined;
      const modelTimeoutMs = Config.timeoutMsForModel(model);
      const result = await this.dispatcher.dispatch(
        model, this.lastPrompt,
        onBytes ? (bytes) => onBytes(model, bytes) : undefined,
        signal, onModelTimeout, modelTimeoutMs
      );
      const durationMs = Date.now() - startTime;

      const success = result.exitCode === 0 && result.stdout.trim().length > 0;
      onProgress(model, success ? 'done' : 'failed');

      let postedToGitHub = false;
      if (success && !signal.aborted) {
        try {
          const comment = `## Audit by \`${model}\`\n\n${result.stdout}\n\n---\n_Automated audit via Fleet Review_`;
          await this.github.postComment(this.lastRepo, this.lastPrNumber, comment);
          postedToGitHub = true;
        } catch {
          // Comment posting is best-effort
        }
      }

      review.results[model] = {
        model, output: result.stdout, success,
        error: success ? undefined : result.stderr || 'Empty output',
        postedToGitHub, durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      const status: ModelStatus = message.includes('timed out') ? 'timeout' : 'failed';
      onProgress(model, status);

      review.results[model] = {
        model, output: '', success: false,
        error: message, postedToGitHub: false, durationMs,
      };
    }

    this.abortController = null;
    this.store.saveReview(review);
    return review;
  }
}
