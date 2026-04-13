import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../src/review/providers/registry';

describe('ProviderRegistry.isSafeGatewayUrl', () => {
  const isSafe = (raw: string): boolean =>
    (ProviderRegistry as unknown as { isSafeGatewayUrl: (r: string) => boolean }).isSafeGatewayUrl(raw);

  it('blocks localhost', () => expect(isSafe('https://localhost/api')).toBe(false));
  it('blocks 127.x', () => expect(isSafe('https://127.0.0.1/api')).toBe(false));
  it('blocks 10.x (RFC 1918)', () => expect(isSafe('https://10.0.0.1/api')).toBe(false));
  it('blocks 172.16.x (RFC 1918)', () => expect(isSafe('https://172.16.0.1/api')).toBe(false));
  it('blocks 172.31.x (RFC 1918)', () => expect(isSafe('https://172.31.255.255/api')).toBe(false));
  it('allows 172.15.x (outside RFC 1918)', () => expect(isSafe('https://172.15.0.1/api')).toBe(true));
  it('blocks 192.168.x (RFC 1918)', () => expect(isSafe('https://192.168.1.1/api')).toBe(false));
  it('blocks 169.254.x (link-local)', () => expect(isSafe('https://169.254.1.1/api')).toBe(false));
  it('blocks [::1]', () => expect(isSafe('https://[::1]/api')).toBe(false));
  it('blocks IPv4-mapped IPv6', () => expect(isSafe('https://[::ffff:127.0.0.1]/api')).toBe(false));
  it('blocks fc00::/7 unique-local', () => expect(isSafe('https://[fc00::1]/api')).toBe(false));
  it('blocks fd00::/8 unique-local', () => expect(isSafe('https://[fd12::1]/api')).toBe(false));
  it('blocks fe80:: link-local', () => expect(isSafe('https://[fe80::1]/api')).toBe(false));
  it('allows public HTTPS', () => expect(isSafe('https://openrouter.ai/api/v1')).toBe(true));
  it('blocks HTTP (not HTTPS)', () => expect(isSafe('http://evil.com/api')).toBe(false));
  it('blocks invalid URL', () => expect(isSafe('not-a-url')).toBe(false));
});
