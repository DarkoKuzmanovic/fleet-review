/**
 * Shared JavaScript snippets embedded into webview <script> blocks.
 * These are plain JS strings (not TypeScript modules) because they run
 * inside the sandboxed webview context, not in the extension host.
 */

export const ESCAPE_HTML_JS = `
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }`;

/** TypeScript-level HTML escaping for use in template literals (extension host). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * JSON.stringify variant safe for embedding inside a <script> block.
 * Escapes `<` and `>` so a string containing `</script>` cannot terminate
 * the script tag and enable HTML/script injection in the webview.
 */
export function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
