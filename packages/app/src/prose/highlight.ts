/**
 * ONE syntax-highlighting registry for the whole application.
 *
 * kteam learned this the expensive way: two call sites each pulled the
 * everything-bundle (`highlight.js/lib/common` in the code block, `lowlight`
 * again through rehype in the markdown renderer) — 303.6 KiB across 233 source
 * modules, most of it parsers this application can never ask for, because
 * `langFromPath` maps a fixed extension table and auto-detection is off by
 * design (it is slow, and it is wrong on logs and command output).
 *
 * So: `highlight.js/lib/core` plus exactly the language definitions that table
 * can return, registered once and shared.
 *
 * WHAT MUST STAY TRUE:
 *   - a recognised fence or tool-result file is highlighted;
 *   - an unrecognised language renders as ESCAPED PLAIN TEXT, never raw HTML;
 *   - nothing is auto-detected.
 *
 * Adding a language is deliberate: add the extension to `EXTENSION_LANGUAGES`
 * in `tool-extract.ts` AND the definition here, or the extension simply renders
 * as plain text.
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import nix from 'highlight.js/lib/languages/nix';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** Every id `langFromPath` can return, plus plaintext for explicit fences. Each
 *  definition registers its OWN aliases (ts/tsx, js/jsx, yml, py, rb,
 *  html/svg, c++, docker, …), which is what makes markdown fences work without
 *  a second table to keep in sync. */
const LANGUAGES: Readonly<Record<string, Parameters<typeof hljs.registerLanguage>[1]>> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  nix,
  perl,
  php,
  plaintext,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);

// Belt and braces for ids that reach us from a fence rather than from the
// extension table and are not aliases of their own definition.
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['toml'], { languageName: 'ini' });
hljs.registerAliases(['patch'], { languageName: 'diff' });
hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });
// ```shell and ```console are the two commonest fences in these transcripts and
// neither is a built-in alias of bash (highlight.js ships a separate `shell`
// grammar for prompt sessions, which is not worth a second parser here).
hljs.registerAliases(['shell', 'console', 'sh-session'], { languageName: 'bash' });

// Auto-detection is OFF: `highlightAuto` is never called from this module, and
// nothing else may import hljs directly.
hljs.configure({ ignoreUnescapedHTML: true });

/** Don't tokenize huge blobs — a 200KB log costs more than it reads. */
const MAX_HIGHLIGHT_CHARS = 60_000;

export const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const isKnownLanguage = (lang?: string): boolean => Boolean(lang && hljs.getLanguage(lang));

/** The tokenizer itself, injectable so the "a parser threw" path is a test and
 *  not a hope: `ignoreIllegals` means production almost never takes it, which
 *  is exactly why it would rot unnoticed. */
export type Tokenizer = (code: string, lang: string) => string;

const highlightJs: Tokenizer = (code, lang) => hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;

/**
 * Highlighted HTML for `code`, or null when this input must be rendered as
 * escaped plain text — no language, an unknown one, too big, or a parser that
 * threw. Callers treat null as "escape it", never as "insert raw".
 */
export const highlightToHtml = (code: string, lang?: string, tokenize: Tokenizer = highlightJs): string | null => {
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(lang)) return null;
  try {
    return tokenize(code, lang);
  } catch {
    return null;
  }
};

/** The language id a markdown fence declared (```ts → `ts`), if any. */
export const fenceLanguage = (className?: string): string | undefined => {
  const match = /(?:^|\s)language-([\w+#-]+)/.exec(className ?? '');
  return match?.[1]?.toLowerCase();
};
