import * as vscode from 'vscode';

import type { HttpGateway, ModelProvider } from './types';
import { buildBuiltInGateways, buildBuiltInProviders } from './builtins';

export interface RegistryOptions {
  defaultTimeoutMs: number;
  customProviders?: ModelProvider[];
  customGateways?: HttpGateway[];
  secrets: vscode.SecretStorage;
  log?: (message: string) => void;
}

export class ProviderRegistry {
  private providers: Map<string, ModelProvider> = new Map();
  private gateways: Map<string, HttpGateway> = new Map();
  private secrets: vscode.SecretStorage;
  private log: (message: string) => void;

  constructor(opts: RegistryOptions) {
    this.secrets = opts.secrets;
    this.log = opts.log ?? (() => { /* noop */ });

    const builtInGatewayNames = new Set<string>();
    for (const gw of buildBuiltInGateways()) {
      this.gateways.set(gw.name, gw);
      builtInGatewayNames.add(gw.name);
    }
    for (const gw of opts.customGateways ?? []) {
      if (!gw.name || !gw.baseUrl) {
        this.log(`Skipping invalid custom gateway: ${JSON.stringify(gw)}`);
        continue;
      }
      if (!ProviderRegistry.isSafeGatewayUrl(gw.baseUrl)) {
        this.log(`Skipping custom gateway '${gw.name}': baseUrl must be https:// and not point to a loopback/link-local address`);
        continue;
      }
      if (builtInGatewayNames.has(gw.name)) {
        this.log(`Skipping custom gateway '${gw.name}': cannot override a built-in gateway. Stored API keys would be sent to '${gw.baseUrl}'.`);
        continue;
      }
      this.gateways.set(gw.name, gw);
    }

    for (const p of buildBuiltInProviders(opts.defaultTimeoutMs)) {
      this.providers.set(p.name, p);
    }
    for (const p of opts.customProviders ?? []) {
      if (!p.name || !p.kind) {
        this.log(`Skipping invalid custom provider: ${JSON.stringify(p)}`);
        continue;
      }
      if (p.kind === 'http' && !this.gateways.has(p.gateway)) {
        this.log(`Skipping provider '${p.name}': unknown gateway '${p.gateway}'`);
        continue;
      }
      this.providers.set(p.name, p);
    }
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  names(): string[] {
    return [...this.providers.keys()];
  }

  get(name: string): ModelProvider | undefined {
    return this.providers.get(name);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  getGateway(name: string): HttpGateway | undefined {
    return this.gateways.get(name);
  }

  listGateways(): HttpGateway[] {
    return [...this.gateways.values()];
  }

  private static secretKey(gatewayName: string): string {
    return `fleet-review.gateway.${gatewayName}.apiKey`;
  }

  private static isSafeGatewayUrl(raw: string): boolean {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '[::1]' ||
      host === '[::]' ||
      host.startsWith('[::ffff:') ||
      // Block any :: prefixed IPv6 that isn't the single :: or ::1 — this
      // catches deprecated IPv4-compatible forms like [::192.168.1.1] which
      // Node normalises to [::c0a8:101] and would otherwise slip through.
      (host.startsWith('[::') && !host.startsWith('[::ffff:')) ||
      /^127\.\d+\.\d+\.\d+$/.test(host) ||
      /^10\.\d+\.\d+\.\d+$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) ||
      /^192\.168\.\d+\.\d+$/.test(host) ||
      host.startsWith('169.254.') ||
      host.startsWith('[fc') ||
      host.startsWith('[fd') ||
      host.startsWith('[fe80:')
    ) {
      return false;
    }
    return true;
  }

  async getGatewayApiKey(gatewayName: string): Promise<string | undefined> {
    const stored = await this.secrets.get(ProviderRegistry.secretKey(gatewayName));
    if (stored) return stored;
    const envKey = `FLEET_REVIEW_${gatewayName.toUpperCase()}_API_KEY`;
    return process.env[envKey] || undefined;
  }

  async setGatewayApiKey(gatewayName: string, apiKey: string): Promise<void> {
    await this.secrets.store(ProviderRegistry.secretKey(gatewayName), apiKey);
  }

  async deleteGatewayApiKey(gatewayName: string): Promise<void> {
    await this.secrets.delete(ProviderRegistry.secretKey(gatewayName));
  }
}
