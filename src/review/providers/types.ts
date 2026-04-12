import type { TimeoutDecision } from '../../types';

export interface BaseProvider {
  name: string;
  displayName: string;
  defaultTimeoutMs: number;
}

export interface CliProvider extends BaseProvider {
  kind: 'cli';
  command: string;
  args: readonly string[];
}

export interface HttpProvider extends BaseProvider {
  kind: 'http';
  gateway: string;
  modelId: string;
}

export type ModelProvider = CliProvider | HttpProvider;

export interface HttpGateway {
  name: string;
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface RunContext {
  onBytes?: (bytes: number) => void;
  signal?: AbortSignal;
  onTimeout?: () => Promise<TimeoutDecision>;
  timeoutMs?: number;
  onText?: (text: string) => void;
  log?: (message: string) => void;
}
