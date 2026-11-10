/**
 * A harness document's text, as a value: `.claude.json` / `settings.json` / `.mcp.json` are JSON, Codex's
 * `config.toml` is TOML. A syntax error throws; the reader that called says only which format it was, never quotes the
 * parser's message (it can echo the document, which may hold a key).
 */
export function parseHarnessDocument(text: string, format: 'json' | 'toml'): unknown {
  return format === 'json' ? (JSON.parse(text) as unknown) : Bun.TOML.parse(text);
}
