import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CliResult } from '../../types';
import type { CliProvider, RunContext } from './types';

export async function runCli(
  provider: CliProvider,
  prompt: string,
  ctx: RunContext = {},
): Promise<CliResult> {
  const promptFile = await writeTempPrompt(provider.name, prompt);
  try {
    return await spawnWithStdin(provider, promptFile, ctx);
  } finally {
    await deleteTempPrompt(promptFile);
  }
}

function killProcessGroup(proc: ReturnType<typeof spawn>): void {
  const pid = proc.pid;
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
  }, 3000);
}

function spawnWithStdin(
  provider: CliProvider,
  promptFile: string,
  ctx: RunContext,
): Promise<CliResult> {
  const { command } = provider;
  const args = [...provider.args];
  const timeoutMs = ctx.timeoutMs ?? provider.defaultTimeoutMs;
  const log = ctx.log ?? (() => { /* noop */ });
  const { onBytes, signal, onTimeout, onText } = ctx;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Review cancelled'));
      return;
    }

    log(`Spawning: ${command} ${args.join(' ')}`);
    log(`Prompt file size: ${fs.statSync(promptFile).size}B`);
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: os.tmpdir(),
      detached: true,
    });
    log(`Spawned ${command} with pid ${proc.pid}`);

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
        } catch { /* fall through to kill */ }
      }
      killProcessGroup(proc);
      settle(() => reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`)));
    };

    startTimer();

    const onAbort = () => {
      killProcessGroup(proc);
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
      const text = chunk.toString();
      stderr += text;
      const trimmed = text.trim();
      if (trimmed) log(`${command} stderr: ${trimmed.substring(0, 200)}`);
    });

    proc.on('error', (err) => {
      log(`${command} error: ${err.message}`);
      signal?.removeEventListener('abort', onAbort);
      settle(() => reject(new Error(`Failed to start ${command}: ${err.message}`)));
    });

    proc.on('close', (code) => {
      log(`${command} exited with code ${code}, stdout=${totalBytes}B, stderr=${stderr.length}B`);
      signal?.removeEventListener('abort', onAbort);
      settle(() => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    });

    const promptContent = fs.readFileSync(promptFile, 'utf-8');
    proc.stdin.write(promptContent);
    proc.stdin.end();
  });
}

async function writeTempPrompt(name: string, prompt: string): Promise<string> {
  const filePath = path.join(os.tmpdir(), `fleet-review-${name}-${randomUUID()}.md`);
  await fs.promises.writeFile(filePath, prompt, 'utf-8');
  return filePath;
}

async function deleteTempPrompt(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore cleanup errors
  }
}
