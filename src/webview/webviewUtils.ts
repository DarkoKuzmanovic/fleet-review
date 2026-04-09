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
