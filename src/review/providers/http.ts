import type { CliResult } from '../../types';
import type { HttpGateway, HttpProvider, RunContext } from './types';

export async function runHttp(
  provider: HttpProvider,
  gateway: HttpGateway,
  apiKey: string,
  prompt: string,
  ctx: RunContext = {},
): Promise<CliResult> {
  const log = ctx.log ?? (() => { /* noop */ });
  const { onBytes, signal, onTimeout, onText } = ctx;
  const effectiveTimeout = ctx.timeoutMs ?? provider.defaultTimeoutMs;

  if (!apiKey) {
    return {
      stdout: '',
      stderr: `${gateway.name} API key not configured. Run "Fleet Review: Set Gateway API Key" to configure it.`,
      exitCode: 1,
    };
  }

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
      } catch { /* fall through to abort */ }
    }
    if (!settled) timeoutController.abort();
  };

  const onCallerAbort = () => timeoutController.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  const endpoint = gateway.baseUrl.replace(/\/$/, '') + '/chat/completions';

  try {
    log(`${provider.name}: POST ${endpoint} (stream)`);
    startTimer();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(gateway.headers ?? {}),
      },
      body: JSON.stringify({
        model: provider.modelId,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      clearTimeout(timer);
      const errorBody = await response.text().catch(() => '');
      log(`${provider.name}: HTTP ${response.status} — ${errorBody.substring(0, 200)}`);
      return { stdout: '', stderr: `${gateway.name} API error ${response.status}: ${errorBody}`, exitCode: 1 };
    }

    startTimer();

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
          processSseLine(line, (delta) => {
            stdout += delta;
            const deltaBytes = Buffer.byteLength(delta, 'utf-8');
            totalBytes += deltaBytes;
            bytesSinceLastCheck += deltaBytes;
            if (onBytes) onBytes(totalBytes);
            if (onText) onText(delta);
          }, (usage) => {
            promptTokens = usage.prompt_tokens ?? 0;
            completionTokens = usage.completion_tokens ?? 0;
          }, log);
        }
      }
      const remaining = decoder.decode() + buffer;
      if (remaining.trim()) {
        processSseLine(remaining, (delta) => {
          stdout += delta;
          const deltaBytes = Buffer.byteLength(delta, 'utf-8');
          totalBytes += deltaBytes;
          if (onBytes) onBytes(totalBytes);
          if (onText) onText(delta);
        }, (usage) => {
          promptTokens = usage.prompt_tokens ?? 0;
          completionTokens = usage.completion_tokens ?? 0;
        }, log);
      }
    } else {
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
    log(`${provider.name}: received ${stdout.length} chars, ${promptTokens}+${completionTokens} tokens`);

    return {
      stdout,
      stderr: '',
      exitCode: stdout.length > 0 ? 0 : 1,
      tokenUsage: (promptTokens || completionTokens)
        ? { prompt: promptTokens, completion: completionTokens }
        : undefined,
    };
  } catch (err) {
    settled = true;
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    const isUserAbort = signal?.aborted === true;
    const isAbort = isUserAbort || (err instanceof Error && err.name === 'AbortError');
    if (isAbort) {
      log(`${provider.name}: request aborted`);
      throw new Error(isUserAbort ? 'Review cancelled' : `${provider.name} timed out after ${effectiveTimeout / 1000}s`);
    }
    log(`${provider.name}: error — ${message}`);
    return { stdout: '', stderr: message, exitCode: 1 };
  } finally {
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

function processSseLine(
  line: string,
  onDelta: (text: string) => void,
  onUsage: (usage: { prompt_tokens?: number; completion_tokens?: number }) => void,
  log: (msg: string) => void = () => { /* noop */ },
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
    if (payload.length > 0 && payload !== '[DONE]') {
      log(`Malformed SSE chunk (len=${payload.length}): ${payload.substring(0, 80)}`);
    }
  }
}
