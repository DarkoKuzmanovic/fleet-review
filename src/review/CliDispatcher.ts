import * as vscode from 'vscode';

import type { CliResult, TimeoutDecision } from '../types';
import { ProviderRegistry } from './providers/registry';
import type { RunContext } from './providers/types';
import { runCli } from './providers/cli';
import { runHttp } from './providers/http';

export class CliDispatcher {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly output?: vscode.OutputChannel,
  ) {}

  private log(message: string): void {
    this.output?.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  async dispatch(
    modelName: string,
    prompt: string,
    onBytes?: (bytes: number) => void,
    signal?: AbortSignal,
    onTimeout?: () => Promise<TimeoutDecision>,
    timeoutMs?: number,
    onText?: (text: string) => void,
  ): Promise<CliResult> {
    const provider = this.registry.get(modelName);
    if (!provider) {
      this.log(`Unknown model: ${modelName}`);
      return { stdout: '', stderr: `Unknown model: ${modelName}`, exitCode: 1 };
    }

    this.log(`Dispatching ${modelName} (${provider.kind})`);
    const ctx: RunContext = {
      onBytes,
      signal,
      onTimeout,
      timeoutMs,
      onText,
      log: (m) => this.log(m),
    };

    if (provider.kind === 'cli') {
      return runCli(provider, prompt, ctx);
    }

    const gateway = this.registry.getGateway(provider.gateway);
    if (!gateway) {
      return {
        stdout: '',
        stderr: `Unknown gateway '${provider.gateway}' for provider '${modelName}'`,
        exitCode: 1,
      };
    }
    const apiKey = (await this.registry.getGatewayApiKey(provider.gateway)) ?? '';
    return runHttp(provider, gateway, apiKey, prompt, ctx);
  }
}
