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
import { ProviderRegistry } from './providers/registry';
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
    private registry: ProviderRegistry,
    private output?: vscode.OutputChannel
  ) {}

  private timeoutMsFor(modelName: string): number {
    return this.registry.get(modelName)?.defaultTimeoutMs ?? Config.timeoutMs;
  }

  get isRunning(): boolean {
    return this.abortController !== null;
  }

  private logCommentFailure(model: string, err: unknown): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    this.output?.appendLine(`Fleet Review: failed to post comment for ${model}: ${errMsg}`);
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
    const commentFailures: string[] = [];
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
          const modelTimeoutMs = this.timeoutMsFor(model);
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

              // Post inline comments for findings with file:line references
              const inlineComments = ReviewOrchestrator.parseInlineFindings(result.stdout, model, pr.files);
              if (inlineComments.length > 0) {
                await this.github.postInlineComments(repo, pr.number, inlineComments);
              }
            } catch (e) {
              this.logCommentFailure(model, e);
              commentFailures.push(model);
            }
          }

          return {
            model,
            output: result.stdout,
            success,
            error: success ? undefined : result.stderr || 'Empty output',
            postedToGitHub,
            durationMs,
            tokenUsage: result.tokenUsage,
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

    if (commentFailures.length > 0) {
      vscode.window.showWarningMessage(`Fleet Review: failed to post GitHub comments for: ${commentFailures.join(', ')}`);
    }

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

    try {
      await this.store.saveReview(review);
    } catch (err) {
      vscode.window.showErrorMessage(`Fleet Review: failed to save review — ${err instanceof Error ? err.message : err}`);
    }
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
    const mergeModel = Config.defaultModels[0] ?? 'claude';
    const result = await this.dispatcher.dispatch(mergeModel, mergePrompt);

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
    try {
      await this.store.saveReview(review);
    } catch (err) {
      vscode.window.showErrorMessage(`Fleet Review: failed to save review — ${err instanceof Error ? err.message : err}`);
    }

    return result.stdout;
  }

  static parseInlineFindings(
    output: string,
    model: string,
    prFiles: string[],
  ): Array<{ path: string; line: number; body: string }> {
    const comments: Array<{ path: string; line: number; body: string }> = [];
    const prFileSet = new Set(prFiles.map(f => f.replace(/^\.\//, '')));

    // Split output into finding blocks: #### [N]. Title ...
    const blocks = output.split(/(?=####\s*\[?\d+\]?\.?\s)/);
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      // Extract title
      const titleMatch = trimmed.match(/####\s*\[?\d+\]?\.?\s*(.+?)(?:\s*—|\n)/);
      if (!titleMatch) continue;

      // Extract file and line: **File:** `path/to/file` L<line>
      const fileMatch = trimmed.match(/\*\*File:\*\*\s*`([^`]+)`\s*L?(\d+)/);
      if (!fileMatch) continue;

      const filePath = fileMatch[1].replace(/^\.\//, '');
      const line = parseInt(fileMatch[2], 10);
      if (!line || line <= 0) continue;

      // Only post if the file is actually in this PR's changed files
      if (!prFileSet.has(filePath)) continue;

      // Extract issue description
      const issueMatch = trimmed.match(/\*\*Issue:\*\*\s*(.+?)(?=\n\*\*|$)/s);
      const issue = issueMatch ? issueMatch[1].trim() : titleMatch[1].trim();

      comments.push({
        path: filePath,
        line,
        body: `**\`${model}\`**: ${issue}`,
      });
    }

    return comments;
  }

  async retrySingleModel(
    model: ModelName,
    review: ReviewRecord,
    onProgress: (model: string, status: ModelStatus) => void,
    onBytes?: (model: string, bytes: number) => void,
    onTimeout?: (model: string) => Promise<TimeoutDecision>,
    onText?: (model: string, text: string) => void
  ): Promise<ReviewRecord> {
    if (!this.lastPrompt) {
      throw new Error('No previous review prompt available for retry');
    }

    const localController = new AbortController();
    this.abortController = localController;
    const { signal } = localController;

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
      const modelTimeoutMs = this.timeoutMsFor(model);
      const result = await this.dispatcher.dispatch(
        model, this.lastPrompt,
        onBytes ? (bytes) => onBytes(model, bytes) : undefined,
        signal, onModelTimeout, modelTimeoutMs,
        onText ? (text) => onText(model, text) : undefined
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
        } catch (e) {
          this.logCommentFailure(model, e);
          vscode.window.showWarningMessage(`Fleet Review: failed to post GitHub comment for ${model}`);
        }
      }

      review.results[model] = {
        model, output: result.stdout, success,
        error: success ? undefined : result.stderr || 'Empty output',
        postedToGitHub, durationMs,
        tokenUsage: result.tokenUsage,
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

    if (this.abortController === localController) {
      this.abortController = null;
    }
    try {
      await this.store.saveReview(review);
    } catch (err) {
      vscode.window.showErrorMessage(`Fleet Review: failed to save review — ${err instanceof Error ? err.message : err}`);
    }
    return review;
  }
}
