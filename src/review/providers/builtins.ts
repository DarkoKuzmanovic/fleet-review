import type { HttpGateway, ModelProvider } from './types';

export function buildBuiltInProviders(defaultTimeoutMs: number): ModelProvider[] {
  return [
    {
      kind: 'cli',
      name: 'claude',
      displayName: 'Claude',
      command: 'claude',
      args: ['-p', '--output-format', 'text'],
      defaultTimeoutMs,
    },
    {
      kind: 'cli',
      name: 'codex',
      displayName: 'Codex',
      command: 'codex',
      args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'],
      defaultTimeoutMs,
    },
    {
      kind: 'cli',
      name: 'gemini',
      displayName: 'Gemini',
      command: 'gemini',
      args: ['-e', '', '-p', 'Review the provided code', '--output-format', 'text'],
      defaultTimeoutMs,
    },
    {
      kind: 'cli',
      name: 'qwen',
      displayName: 'Qwen',
      command: 'qwen',
      args: ['-p', '', '--output-format', 'text'],
      defaultTimeoutMs,
    },
    {
      kind: 'cli',
      name: 'copilot',
      displayName: 'Copilot',
      command: 'copilot',
      args: ['-p', '', '-s', '--model', 'gpt-5.3-codex', '--effort', 'high', '--allow-all-tools'],
      defaultTimeoutMs,
    },
    {
      kind: 'http',
      name: 'glm',
      displayName: 'GLM',
      gateway: 'nanogpt',
      modelId: 'zai-org/glm-5:thinking',
      defaultTimeoutMs,
    },
  ];
}

export function buildBuiltInGateways(): HttpGateway[] {
  return [
    { name: 'nanogpt', baseUrl: 'https://nano-gpt.com/api/v1' },
    { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
  ];
}
