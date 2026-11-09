/**
 * A configuration file's TEXT, read with every problem located to a line and column.
 *
 * Reading uses the `yaml` package's Document API with YAML 1.2's core schema rather than `Bun.YAML`, so a syntax error
 * is located and `off` and `no` stay strings. Writing a file is the kernel's (`ConfigPort`): it edits only the changed
 * keys, so this module has no edit half.
 *
 * Pure: text in, value out.
 */
import { LineCounter, parseDocument } from 'yaml';

/** A 1-based place in a file. */
interface TextPosition {
  readonly line: number;
  readonly column: number;
}

/** A file read: its plain value. */
export interface ReadConfigText {
  readonly value: unknown;
}

/** A syntax error, located. */
export interface ConfigSyntaxError {
  readonly message: string;
  readonly position?: TextPosition;
}

/** Read with YAML 1.2's core schema: `off` and `no` are strings, not booleans, wherever they are read. */
const PARSE_OPTIONS = { version: '1.2', uniqueKeys: true, prettyErrors: false } as const;

/** Parse one file. A document that does not parse answers its syntax errors and nothing else. */
export function readConfigText(
  text: string,
):
  | { readonly ok: true; readonly read: ReadConfigText }
  | { readonly ok: false; readonly errors: readonly ConfigSyntaxError[] } {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { ...PARSE_OPTIONS, lineCounter });
  if (document.errors.length > 0) {
    return {
      ok: false,
      errors: document.errors.map(error => {
        const position = lineCounter.linePos(error.pos[0]);
        // The parser's message ends with an excerpt of the line; the location says the same thing.
        return {
          message: error.message.split('\n')[0] ?? error.message,
          position: { line: position.line, column: position.col },
        };
      }),
    };
  }
  // An empty file is an empty mapping: every setting left at its default.
  return { ok: true, read: { value: document.toJS() ?? {} } };
}
