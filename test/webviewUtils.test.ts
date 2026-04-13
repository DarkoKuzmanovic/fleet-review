import { describe, it, expect } from 'vitest';
import { safeJsonForHtml, escapeHtml } from '../src/webview/webviewUtils';

describe('safeJsonForHtml', () => {
  it('escapes < to prevent </script> breakout', () => {
    expect(safeJsonForHtml('</script>')).toContain('\\u003c');
  });
  it('escapes >', () => {
    expect(safeJsonForHtml('x>y')).toContain('\\u003e');
  });
  it('escapes U+2028 line separator', () => {
    const input = 'hello\u2028world';
    const result = safeJsonForHtml(input);
    expect(result).not.toContain('\u2028');
    expect(result).toContain('\\u2028');
  });
  it('escapes U+2029 paragraph separator', () => {
    const input = 'hello\u2029world';
    const result = safeJsonForHtml(input);
    expect(result).not.toContain('\u2029');
    expect(result).toContain('\\u2029');
  });
  it('round-trips through JSON.parse', () => {
    const input = 'hello\u2028world</script>';
    const escaped = safeJsonForHtml(input);
    expect(JSON.parse(escaped)).toBe(input);
  });
});

describe('escapeHtml', () => {
  it('escapes all five HTML special chars', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
