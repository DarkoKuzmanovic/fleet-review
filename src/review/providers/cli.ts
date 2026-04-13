import { spawn } from 'child_process';
import * as os from 'os';

import type { CliResult } from '../../types';
import type { CliProvider, RunContext } from './types';

export async function runCli(
  provider: CliProvider,
  prompt: string,
  ctx: RunContext = {},
): Promise<CliResult> {
  return spawnWithStdin(provider, prompt, ctx);
}

function killProcessGroup(proc: ReturnType<typeof spawn>): void {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try { proc.kill(); } catch { /* already dead */ }
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
  }, 3000);
}

function spawnWithStdin(
  provider: CliProvider,
  prompt: string,
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
    log(`Prompt size: ${prompt.length} chars`);
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

    proc.stdin.on('error', (err) => {
      log(`${command} stdin error: ${err.message}`);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

