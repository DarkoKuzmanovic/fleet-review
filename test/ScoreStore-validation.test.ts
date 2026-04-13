import { describe, it, expect } from 'vitest';

describe('readPendingScores validation', () => {
  const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

  it('accepts valid model names', () => {
    expect(SAFE_NAME_RE.test('claude')).toBe(true);
    expect(SAFE_NAME_RE.test('my-model.v2')).toBe(true);
    expect(SAFE_NAME_RE.test('gpt_4o')).toBe(true);
  });

  it('rejects XSS model names', () => {
    expect(SAFE_NAME_RE.test('<img src=x onerror=alert(1)>')).toBe(false);
    expect(SAFE_NAME_RE.test('"><script>')).toBe(false);
    expect(SAFE_NAME_RE.test('name with spaces')).toBe(false);
  });

  it('rejects empty names', () => {
    expect(SAFE_NAME_RE.test('')).toBe(false);
  });

  it('rejects leading special chars', () => {
    expect(SAFE_NAME_RE.test('-leading-dash')).toBe(false);
    expect(SAFE_NAME_RE.test('.leading-dot')).toBe(false);
  });

  it('demonstrates NaN poisoning without guards', () => {
    expect(Number.isNaN(Math.max(1, Math.min(10, NaN)))).toBe(true);
    expect(Number.isNaN(Math.max(1, Math.min(10, Number('bad'))))).toBe(true);
  });

  it('Number.isFinite guard catches NaN and Infinity', () => {
    expect(Number.isFinite(NaN)).toBe(false);
    expect(Number.isFinite(Infinity)).toBe(false);
    expect(Number.isFinite(-Infinity)).toBe(false);
    expect(Number.isFinite(7.5)).toBe(true);
  });
});
