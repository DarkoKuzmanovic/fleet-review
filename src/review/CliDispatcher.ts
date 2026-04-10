import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { CliResult, ModelName, TimeoutDecision } from '../types';
import { Config } from '../config';

export class CliDispatcher {
  constructor(private readonly output?: vscode.OutputChannel) {}

  private log(message: string): void {
    this.output?.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  async dispatch(
    model: ModelName,
    prompt: string,
    onBytes?: (bytes: number) => void,
    signal?: AbortSignal,
    onTimeout?: () => Promise<TimeoutDecision>,
    timeoutMs?: number,
    onText?: (text: string) => void
  ): Promise<CliResult> {
    this.log(`Dispatching ${model}`);

    if (model === 'glm') {
      return this.httpDispatch(prompt, onBytes, signal, onTimeout, timeoutMs, onText);
    }

    const promptFile = await this.writeTempPrompt(model, prompt);
    try {
      switch (model) {
        case 'claude':
          return await this.spawnWithStdin('claude', ['-p', '--output-format', 'text'], promptFile, onBytes, signal, onTimeout, timeoutMs, onText);
        case 'codex':
          return await this.spawnWithStdin('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'], promptFile, onBytes, signal, onTimeout, timeoutMs, onText);
        case 'gemini':
          const geminiArgs = ['-e', '', '-p', 'Review the provided code', '--output-format', 'text'];
          if (Config.geminiModel !== 'auto') {
            geminiArgs.unshift('--model', Config.geminiModel);
          }
          return await this.spawnWithStdin('gemini', geminiArgs, promptFile, onBytes, signal, onTimeout, timeoutMs, onText);
        case 'qwen':
          return await this.spawnWithStdin('qwen', ['-p', '', '--output-format', 'text'], promptFile, onBytes, signal, onTimeout, timeoutMs, onText);
        case 'copilot':
          return await this.spawnWithStdin('copilot', ['-p', '', '-s', '--model', 'gpt-5.3-codex', '--effort', 'high', '--allow-all-tools'], promptFile, onBytes, signal, onTimeout, timeoutMs, onText);
        default:
          throw new Error(`Unknown model: ${model}`);
      }
    } finally {
      await this.deleteTempPrompt(promptFile);
    }
  }

  private async httpDispatch(
    prompt: string,
    onBytes?: (bytes: number) => void,
    signal?: AbortSignal,
    onTimeout?: () => Promise<TimeoutDecision>,
    timeoutMs?: number,
    onText?: (text: string) => void
  ): Promise<CliResult> {
    const apiKey = Config.nanoGptApiKey;
    if (!apiKey) {
      return { stdout: '', stderr: 'Nano-GPT API key not configured. Set fleetReview.nanoGptApiKey or NANO_GPT_API_KEY env var.', exitCode: 1 };
    }

    const effectiveTimeout = timeoutMs ?? Config.timeoutMs;
    const timeoutController = new AbortController();
    let totalBytes = 0;
    let bytesSinceLastCheck = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let promptTokens = 0;
    let completionTokens = 0;

    const startTimer = () => {
      clearTimeout(timer);
      bytesSinceLastCheck = 0;
      timer = setTimeout(() => handleTimeout(), effectiveTimeout);
    };

    const handleTimeout = async () => {
      if (bytesSinceLastCheck > 0) {
        startTimer();
        return;
      }
      if (onTimeout) {
        try {
          const decision = await onTimeout();
          if (settled) return;
          if (decision === 'extend') {
            startTimer();
            return;
          }
        } catch {
          // fall through to abort
        }
      }
      if (!settled) timeoutController.abort();
    };

    // Abort if the caller's signal fires
    const onCallerAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      this.log('GLM: POST https://nano-gpt.com/api/v1/chat/completions (stream)');
      startTimer(); // Start before fetch so DNS/TLS/connect stalls are covered
      const response = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'zai-org/glm-5:thinking',
          messages: [{ role: 'user', content: prompt }],
          stream: true,
        }),
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        clearTimeout(timer);
        const errorBody = await response.text().catch(() => '');
        this.log(`GLM: HTTP ${response.status} — ${errorBody.substring(0, 200)}`);
        return { stdout: '', stderr: `Nano-GPT API error ${response.status}: ${errorBody}`, exitCode: 1 };
      }

      startTimer(); // Reset timer now that headers have arrived

      let stdout = '';

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            this.processSseLine(line, (delta) => {
              stdout += delta;
              const deltaBytes = Buffer.byteLength(delta, 'utf-8');
              totalBytes += deltaBytes;
              bytesSinceLastCheck += deltaBytes;
              if (onBytes) onBytes(totalBytes);
              if (onText) onText(delta);
            }, (usage) => {
              promptTokens = usage.prompt_tokens ?? 0;
              completionTokens = usage.completion_tokens ?? 0;
            });
          }
        }

        // Flush any trailing data left in the buffer after the stream ends
        const remaining = decoder.decode() + buffer;
        if (remaining.trim()) {
          this.processSseLine(remaining, (delta) => {
            stdout += delta;
            const deltaBytes = Buffer.byteLength(delta, 'utf-8');
            totalBytes += deltaBytes;
            if (onBytes) onBytes(totalBytes);
            if (onText) onText(delta);
          }, (usage) => {
            promptTokens = usage.prompt_tokens ?? 0;
            completionTokens = usage.completion_tokens ?? 0;
          });
        }
      } else {
        // Fallback for environments without streaming body support
        const data = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        stdout = data.choices?.[0]?.message?.content ?? '';
        totalBytes = Buffer.byteLength(stdout, 'utf-8');
        if (onBytes) onBytes(totalBytes);
        if (onText && stdout) onText(stdout);
        if (data.usage) {
          promptTokens = data.usage.prompt_tokens ?? 0;
          completionTokens = data.usage.completion_tokens ?? 0;
        }
      }

      settled = true;
      clearTimeout(timer);
      this.log(`GLM: received ${stdout.length} chars, ${promptTokens}+${completionTokens} tokens`);

      return {
        stdout, stderr: '', exitCode: stdout.length > 0 ? 0 : 1,
        tokenUsage: (promptTokens || completionTokens) ? { prompt: promptTokens, completion: completionTokens } : undefined,
      };
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort')) {
        this.log('GLM: request aborted');
        throw new Error(signal?.aborted ? 'Review cancelled' : `glm timed out after ${effectiveTimeout / 1000}s`);
      }
      this.log(`GLM: error — ${message}`);
      return { stdout: '', stderr: message, exitCode: 1 };
    } finally {
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private processSseLine(
    line: string,
    onDelta: (text: string) => void,
    onUsage: (usage: { prompt_tokens?: number; completion_tokens?: number }) => void,
  ): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data: ')) return;
    const payload = trimmed.slice(6);
    if (payload === '[DONE]') return;

    try {
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const delta = chunk.choices?.[0]?.delta?.content ?? '';
      if (delta) onDelta(delta);
      if (chunk.usage) onUsage(chunk.usage);
    } catch {
      // skip malformed SSE chunks
    }
  }

  private killProcessGroup(proc: ReturnType<typeof spawn>): void {
    const pid = proc.pid;
    if (!pid) return;

    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Process may already be dead
    }

    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }, 3000);
  }

  private spawnWithStdin(
    command: string,
    args: string[],
    promptFile: string,
    onBytes?: (bytes: number) => void,
    signal?: AbortSignal,
    onTimeout?: () => Promise<TimeoutDecision>,
    overrideTimeoutMs?: number,
    onText?: (text: string) => void
  ): Promise<CliResult> {
    const timeoutMs = overrideTimeoutMs ?? Config.timeoutMs;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Review cancelled'));
        return;
      }

      this.log(`Spawning: ${command} ${args.join(' ')}`);
      this.log(`Prompt file size: ${fs.statSync(promptFile).size}B`);
      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        cwd: os.tmpdir(),
        detached: true,
      });
      this.log(`Spawned ${command} with pid ${proc.pid}`);

      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) this.log(`${command} stderr: ${text.substring(0, 200)}`);
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let totalBytes = 0;
      let bytesSinceLastCheck = 0;
      let timer: ReturnType<typeof setTimeout>;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const startTimer = () => {
        clearTimeout(timer);
        bytesSinceLastCheck = 0;
        timer = setTimeout(() => handleTimeout(), timeoutMs);
      };

      const handleTimeout = async () => {
        // If stdout has flowed since last check, auto-extend — the model is actively producing output
        if (bytesSinceLastCheck > 0) {
          startTimer();
          return;
        }

        // No stdout yet — ask the user if onTimeout is provided
        if (onTimeout) {
          try {
            const decision = await onTimeout();
            if (settled) return; // process finished while we waited for user
            if (decision === 'extend') {
              startTimer();
              return;
            }
          } catch {
            // If onTimeout fails, fall through to kill
          }
        }

        this.killProcessGroup(proc);
        settle(() => reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`)));
      };

      startTimer();

      // Listen for abort signal (cancel button)
      const onAbort = () => {
        this.killProcessGroup(proc);
        settle(() => reject(new Error('Review cancelled')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        totalBytes += chunk.length;
        bytesSinceLastCheck += chunk.length;
        if (onBytes) onBytes(totalBytes);
        if (onText) onText(text);
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        this.log(`${command} error: ${err.message}`);
        signal?.removeEventListener('abort', onAbort);
        settle(() => reject(new Error(`Failed to start ${command}: ${err.message}`)));
      });

      proc.on('close', (code) => {
        this.log(`${command} exited with code ${code}, stdout=${totalBytes}B, stderr=${stderr.length}B`);
        signal?.removeEventListener('abort', onAbort);
        settle(() => resolve({ stdout, stderr, exitCode: code ?? 1 }));
      });

      // Pipe the prompt file content to stdin
      const promptContent = fs.readFileSync(promptFile, 'utf-8');
      proc.stdin.write(promptContent);
      proc.stdin.end();
    });
  }

  private async writeTempPrompt(model: string, prompt: string): Promise<string> {
    const filePath = path.join(
      os.tmpdir(),
      `fleet-review-${model}-${randomUUID()}.md`
    );
    await fs.promises.writeFile(filePath, prompt, 'utf-8');
    return filePath;
  }

  private async deleteTempPrompt(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // ignore cleanup errors
    }
  }
}
