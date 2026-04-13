import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

import { ProjectType, SAFE_NAME_RE } from './types';
import type { HttpGateway, ModelProvider } from './review/providers/types';

export class Config {
  static get defaultModels(): string[] {
    const raw = vscode.workspace
      .getConfiguration('fleetReview')
      .get<string[]>('defaultModels', ['claude', 'gemini', 'qwen']);
    return raw.filter((m) => typeof m === 'string' && m.length > 0);
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

  static get customProviders(): ModelProvider[] {
    const raw = vscode.workspace
      .getConfiguration('fleetReview')
      .get<unknown[]>('customProviders', []);
    if (!Array.isArray(raw)) return [];
    const out: ModelProvider[] = [];
    for (const entry of raw) {
      const p = Config.parseProviderEntry(entry);
      if (p) out.push(p);
    }
    return out;
  }

  static get customGateways(): HttpGateway[] {
    const raw = vscode.workspace
      .getConfiguration('fleetReview')
      .get<unknown[]>('customGateways', []);
    if (!Array.isArray(raw)) return [];
    const out: HttpGateway[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== 'string' || typeof e.baseUrl !== 'string') continue;
      if (!SAFE_NAME_RE.test(e.name)) continue;
      const gateway: HttpGateway = { name: e.name, baseUrl: e.baseUrl };
      if (e.headers && typeof e.headers === 'object' && !Array.isArray(e.headers)) {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.headers as Record<string, unknown>)) {
          if (typeof v === 'string') headers[k] = v;
        }
        if (Object.keys(headers).length > 0) gateway.headers = headers;
      }
      out.push(gateway);
    }
    return out;
  }

  private static parseProviderEntry(entry: unknown): ModelProvider | null {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || typeof e.displayName !== 'string') return null;
    if (!SAFE_NAME_RE.test(e.name)) return null;
    const timeoutSec = typeof e.timeoutSeconds === 'number' && e.timeoutSeconds > 0
      ? e.timeoutSeconds
      : Config.defaultTimeoutSeconds;
    const defaultTimeoutMs = timeoutSec * 1000;

    if (e.kind === 'cli') {
      if (typeof e.command !== 'string' || !Array.isArray(e.args)) return null;
      const args = e.args.filter((a): a is string => typeof a === 'string');
      return {
        kind: 'cli',
        name: e.name,
        displayName: e.displayName,
        command: e.command,
        args,
        defaultTimeoutMs,
      };
    }

    if (e.kind === 'http') {
      if (typeof e.gateway !== 'string' || typeof e.modelId !== 'string') return null;
      return {
        kind: 'http',
        name: e.name,
        displayName: e.displayName,
        gateway: e.gateway,
        modelId: e.modelId,
        defaultTimeoutMs,
      };
    }

    return null;
  }

  static get diffSizeWarningThreshold(): number {
    return vscode.workspace
      .getConfiguration('fleetReview')
      .get<number>('diffSizeWarningThreshold', 1500);
  }

  static get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  static getProjectPrompt(projectType: ProjectType): string | undefined {
    const prompts = vscode.workspace
      .getConfiguration('fleetReview')
      .get<Record<string, string>>('projectPrompts', {});
    return prompts[projectType] || undefined;
  }

  static getProjectHint(projectType: ProjectType): string | undefined {
    const hints = vscode.workspace
      .getConfiguration('fleetReview')
      .get<Record<string, string>>('projectHints', {});
    return hints[projectType] || undefined;
  }
}
