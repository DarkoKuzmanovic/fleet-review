import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

import { ModelName, MODEL_NAMES } from './types';

export class Config {
  static get defaultModels(): ModelName[] {
    const raw = vscode.workspace
      .getConfiguration('fleetReview')
      .get<string[]>('defaultModels', ['claude', 'gemini', 'qwen']);
    return raw.filter((m): m is ModelName =>
      MODEL_NAMES.includes(m as ModelName)
    );
  }

  static get dataDir(): string {
    const raw = vscode.workspace
      .getConfiguration('fleetReview')
      .get<string>('dataDir', '~/.config/fleet-review');
    return raw.startsWith('~')
      ? path.join(os.homedir(), raw.slice(1))
      : raw;
  }

  static get defaultTimeoutSeconds(): number {
    return vscode.workspace
      .getConfiguration('fleetReview')
      .get<number>('timeoutSeconds', 300);
  }

  static get timeoutMs(): number {
    return Config.defaultTimeoutSeconds * 1000;
  }

  static timeoutMsForModel(model: ModelName): number {
    const overrides = vscode.workspace
      .getConfiguration('fleetReview')
      .get<Record<string, number>>('modelTimeouts', {});
    const seconds = overrides[model] ?? Config.defaultTimeoutSeconds;
    return seconds * 1000;
  }

  static get modelTimeouts(): Record<string, number> {
    const overrides = vscode.workspace
      .getConfiguration('fleetReview')
      .get<Record<string, number>>('modelTimeouts', {});
    const result: Record<string, number> = {};
    for (const m of MODEL_NAMES) {
      result[m] = overrides[m] ?? Config.defaultTimeoutSeconds;
    }
    return result;
  }

  static get geminiModel(): string {
    return vscode.workspace
      .getConfiguration('fleetReview')
      .get<string>('geminiModel', 'auto');
  }

  static get nanoGptApiKey(): string {
    const key = vscode.workspace
      .getConfiguration('fleetReview')
      .get<string>('nanoGptApiKey', '');
    return key || process.env.NANO_GPT_API_KEY || '';
  }

  static get diffSizeWarningThreshold(): number {
    return vscode.workspace
      .getConfiguration('fleetReview')
      .get<number>('diffSizeWarningThreshold', 1500);
  }

  static get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
}
