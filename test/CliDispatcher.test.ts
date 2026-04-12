import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';

vi.mock('vscode');

vi.mock('../src/config', () => ({
  Config: {
    timeoutMs: 300000,
    defaultTimeoutSeconds: 300,
  },
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    statSync: vi.fn(() => ({ size: 100 })),
    readFileSync: vi.fn(() => 'prompt content'),
    promises: {
      ...actual.promises,
      writeFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    },
  };
});

import { CliDispatcher } from '../src/review/CliDispatcher';
import { ProviderRegistry } from '../src/review/providers/registry';

const mockSpawn = vi.mocked(spawn);

function createMockProcess(stdout = '', exitCode = 0, errorEvent?: Error) {
  const proc = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: Object.assign(new EventEmitter(), {}),
    stderr: Object.assign(new EventEmitter(), {}),
    kill: vi.fn(),
  });

  setTimeout(() => {
    if (errorEvent) {
      proc.emit('error', errorEvent);
      return;
    }
    if (stdout) {
      proc.stdout.emit('data', Buffer.from(stdout));
    }
    proc.emit('close', exitCode);
  }, 10);

  return proc;
}

function createRegistry(): ProviderRegistry {
  const secrets = {
    get: async () => undefined,
    store: async () => {},
    delete: async () => {},
    onDidChange: () => ({ dispose() {} }),
  } as unknown as import('vscode').SecretStorage;

  return new ProviderRegistry({
    defaultTimeoutMs: 300000,
    secrets,
  });
}

describe('CliDispatcher.dispatch - command routing', () => {
  let dispatcher: CliDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FLEET_REVIEW_NANOGPT_API_KEY;
    dispatcher = new CliDispatcher(createRegistry());
  });

  it('spawns claude with correct args', async () => {
    mockSpawn.mockReturnValue(createMockProcess('review output') as any);
    await dispatcher.dispatch('claude', 'test prompt');
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['-p', '--output-format', 'text'],
      expect.any(Object)
    );
  });

  it('spawns codex with correct args', async () => {
    mockSpawn.mockReturnValue(createMockProcess('review output') as any);
    await dispatcher.dispatch('codex', 'test prompt');
    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.3-codex', '--effort', 'high', '-'],
      expect.any(Object)
    );
  });

  it('spawns qwen with correct args', async () => {
    mockSpawn.mockReturnValue(createMockProcess('review output') as any);
    await dispatcher.dispatch('qwen', 'test prompt');
    expect(mockSpawn).toHaveBeenCalledWith(
      'qwen',
      ['-p', '', '--output-format', 'text'],
      expect.any(Object)
    );
  });

  it('spawns gemini with correct args', async () => {
    mockSpawn.mockReturnValue(createMockProcess('review output') as any);
    await dispatcher.dispatch('gemini', 'test prompt');
    expect(mockSpawn).toHaveBeenCalledWith(
      'gemini',
      ['-e', '', '-p', 'Review the provided code', '--output-format', 'text'],
      expect.any(Object)
    );
  });

  it('spawns copilot with correct args', async () => {
    mockSpawn.mockReturnValue(createMockProcess('review output') as any);
    await dispatcher.dispatch('copilot', 'test prompt');
    expect(mockSpawn).toHaveBeenCalledWith(
      'copilot',
      ['-p', '', '-s', '--model', 'gpt-5.3-codex', '--effort', 'high', '--allow-all-tools'],
      expect.any(Object)
    );
  });

  it('returns error for unknown model instead of spawning', async () => {
    const result = await dispatcher.dispatch('no-such-model', 'test prompt');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown model');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('CliDispatcher.dispatch - glm (http) routing', () => {
  let dispatcher: CliDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FLEET_REVIEW_NANOGPT_API_KEY;
    dispatcher = new CliDispatcher(createRegistry());
  });

  it('returns error result for glm when no API key is configured', async () => {
    const result = await dispatcher.dispatch('glm', 'test prompt');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('nanogpt API key not configured');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('CliDispatcher.dispatch - process results', () => {
  let dispatcher: CliDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FLEET_REVIEW_NANOGPT_API_KEY;
    dispatcher = new CliDispatcher(createRegistry());
  });

  it('returns stdout from successful process', async () => {
    mockSpawn.mockReturnValue(createMockProcess('great review text') as any);
    const result = await dispatcher.dispatch('claude', 'prompt');
    expect(result.stdout).toBe('great review text');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('returns failure result when process exits with non-zero code', async () => {
    mockSpawn.mockReturnValue(createMockProcess('', 1) as any);
    const result = await dispatcher.dispatch('claude', 'prompt');
    expect(result.exitCode).toBe(1);
  });

  it('rejects on spawn error event', async () => {
    mockSpawn.mockReturnValue(createMockProcess('', 0, new Error('ENOENT spawn error')) as any);
    await expect(dispatcher.dispatch('claude', 'prompt')).rejects.toThrow('Failed to start claude');
  });

  it('collects stderr output', async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 99,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: Object.assign(new EventEmitter(), {}),
      stderr: Object.assign(new EventEmitter(), {}),
      kill: vi.fn(),
    });

    setTimeout(() => {
      proc.stderr.emit('data', Buffer.from('some warning'));
      proc.stdout.emit('data', Buffer.from('output'));
      proc.emit('close', 0);
    }, 10);

    mockSpawn.mockReturnValue(proc as any);
    const result = await dispatcher.dispatch('claude', 'prompt');
    expect(result.stderr).toContain('some warning');
    expect(result.stdout).toContain('output');
  });
});

describe('CliDispatcher.dispatch - abort signal', () => {
  let dispatcher: CliDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FLEET_REVIEW_NANOGPT_API_KEY;
    dispatcher = new CliDispatcher(createRegistry());
  });

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    mockSpawn.mockReturnValue(createMockProcess('output') as any);

    await expect(
      dispatcher.dispatch('claude', 'prompt', undefined, controller.signal)
    ).rejects.toThrow('Review cancelled');
  });
});
