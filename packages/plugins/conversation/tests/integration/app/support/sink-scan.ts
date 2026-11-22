import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

/**
 * THE SCAN THAT KEEPS DURIAN'S SOURCE FREE OF AN HTML-STRING SINK (r12 H4 review R1, S2). A pin bump that adds a sink
 * must fail here, so the scan may never be vacuous. Three things made the first one so, and each is closed:
 *
 *  - PATHS ARE RESOLVED AGAINST THE CWD THE BUILD USED. Bun writes a metafile's inputs relative to the cwd of the
 *    process that built, not to any package root; resolving them from somewhere else opened 0 of 42 files.
 *  - AN UNREADABLE FILE IS A FAILURE. `readFile` throws and nothing catches it, so a missing file can never read as
 *    "clean text".
 *  - COMMENTS ARE REMOVED BY A TOKENIZER, NOT BY A PATTERN. Bun's own transpiler drops comments and keeps every string,
 *    so `"https://x"; el.innerHTML = y` on one line is still seen, and a comment that talks about `innerHTML` is not
 *    a sink. A file it cannot parse throws, which is a failure too.
 *
 * THE SINKS: every spelling that writes markup from a string, or parses one: React's `dangerouslySetInnerHTML`;
 * `innerHTML` and `outerHTML` (any assignment, `+=` included, and the bracket spelling); `insertAdjacentHTML`;
 * `createContextualFragment`; `setHTMLUnsafe` and `parseHTMLUnsafe`; `DOMParser`; `document.write` and `writeln`;
 * `srcdoc`. A bare mention of `innerHTML` is a hit too: a read of it is not a write, but nothing in a UI library that
 * must stay sink-free needs either, and a hit is cheap to look at.
 */
const HTML_SINK =
  /dangerouslySetInnerHTML|\b(?:inner|outer)HTML\b|insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe|DOMParser|document\s*\.\s*write(?:ln)?\b|\bsrcdoc\b/u;

const LOADERS = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js' } as const;

/** `text` of one source file with its comments removed, by Bun's own parser. Throws on a syntax it cannot read. */
function withoutComments(path: string, text: string): string {
  const loader = LOADERS[extname(path) as keyof typeof LOADERS];
  if (loader === undefined) throw new Error(`❌ the sink scan cannot read ${path}: no loader for ${extname(path)}`);
  return new Bun.Transpiler({ loader }).transformSync(text);
}

export interface SinkScan {
  /** How many files were opened and read. */
  readonly scanned: number;
  /** The inputs in which a sink was found. */
  readonly hits: readonly string[];
}

/**
 * Reads every one of `inputs` (paths as the build's metafile wrote them) from `cwd`, the directory the build ran in, and
 * reports the ones that hold a sink. A file that cannot be read or parsed REJECTS: it is never skipped.
 */
export async function scanForHtmlSinks(inputs: readonly string[], cwd: string): Promise<SinkScan> {
  const hits: string[] = [];
  let scanned = 0;
  for (const input of inputs) {
    const text = await readFile(resolve(cwd, input), 'utf8');
    scanned++;
    if (HTML_SINK.test(withoutComments(input, text))) hits.push(input);
  }
  return { scanned, hits };
}
