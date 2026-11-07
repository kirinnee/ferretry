/**
 * The shell a ferret types, read just enough to tell which `fy` command it ran (today's `peer-delivery.ts` words,
 * copied: Conversation reads the same transcript for `send`, and the two copies read one grammar). A command this reader
 * cannot make out stays an ordinary tool call — never a card claiming what it did not see.
 */

import type { ToolCall } from './shell-ports.ts';

/** The command a shell-running tool call ran, for Claude's `Bash` and Codex's exec tools. */
export const shellCommandOf = (call: Pick<ToolCall, 'use'>): string | undefined => {
  const { name, input } = call.use;
  const lower = (name ?? '').toLowerCase();
  const object = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : undefined;
  if (object === undefined) return undefined;
  const fields = object as Record<string, unknown>;
  if (lower === 'bash') return typeof fields['command'] === 'string' ? fields['command'] : undefined;
  if (lower === 'exec_command') return typeof fields['cmd'] === 'string' ? fields['cmd'] : undefined;
  if (lower === 'shell' || lower === 'local_shell') {
    const command = fields['command'];
    if (!Array.isArray(command) || !command.every(part => typeof part === 'string')) return undefined;
    // `["bash", "-lc", "<script>"]` is how Codex runs every script; the script is the command.
    const shells = new Set(['bash', 'sh', 'zsh']);
    if (command.length === 3 && shells.has(command[0] as string) && /^-l?c$/u.test(command[1] as string))
      return command[2] as string;
    return command.join(' ');
  }
  return undefined;
};

/** One shell word as written, and whether any of it was a shell expansion this reader cannot run. */
export interface Word {
  readonly text: string;
  readonly expanded: boolean;
}

/** What ends a simple command, outside quotes. */
const OPERATORS = new Set([';', '&', '|', '\n']);

/**
 * `"$(cat <<'EOF' … EOF)"` — the one expansion agents use to send a long message — replaced by its
 * body. The tag may be quoted or bare; the body is taken verbatim, as a quoted heredoc is.
 */
const HEREDOC_SUBSTITUTION = /\$\(cat <<-?\s*(['"]?)(\w+)\1\n([\s\S]*?)\n\2\n?\s*\)/gu;

const expandHeredocs = (script: string): { readonly script: string; readonly bodies: readonly string[] } => {
  const bodies: string[] = [];
  const replaced = script.replace(HEREDOC_SUBSTITUTION, (_all, _quote, _tag, body: string) => {
    bodies.push(body);
    return `\u0000${bodies.length - 1}\u0000`;
  });
  return { script: replaced, bodies };
};

/** A redirection operator at one spot of the script: where it ends, and what follows it. */
interface Redirection {
  /** The index of the first character after the operator (and after its fd target, for `>&1`). */
  readonly next: number;
  /** The next word is the redirection's target (a file, a here-string, a heredoc tag), not an argument. */
  readonly target: 'none' | 'word' | 'heredoc' | 'heredoc-indented';
}

/** `>&1`, `<&3`, `>&-`, `>&2-`: a duplication names its own target, so no word follows. */
const DUPLICATION = /^&(?:\d+-?|-)/u;

/**
 * The shell redirection starting at `at`, or `undefined` when the character there is not one: `>`,
 * `>>`, `>|`, `>&m`, `<`, `<<`, `<<-`, `<<<`, `<&m`, `<>`, `&>` and `&>>`. Called only outside quotes.
 */
const redirectionAt = (source: string, at: number): Redirection | undefined => {
  const character = source[at];
  if (character === '&') {
    if (source[at + 1] !== '>') return undefined;
    return { next: source[at + 2] === '>' ? at + 3 : at + 2, target: 'word' };
  }
  if (character === '>') {
    const next = at + (source[at + 1] === '>' || source[at + 1] === '|' ? 2 : 1);
    const duplication = DUPLICATION.exec(source.slice(next, next + 24));
    if (duplication !== null) return { next: next + duplication[0].length, target: 'none' };
    return { next: source[next] === '&' ? next + 1 : next, target: 'word' };
  }
  if (character !== '<') return undefined;
  if (source.startsWith('<<<', at)) return { next: at + 3, target: 'word' };
  if (source.startsWith('<<-', at)) return { next: at + 3, target: 'heredoc-indented' };
  if (source.startsWith('<<', at)) return { next: at + 2, target: 'heredoc' };
  const duplication = DUPLICATION.exec(source.slice(at + 1, at + 25));
  if (duplication !== null) return { next: at + 1 + duplication[0].length, target: 'none' };
  return { next: source[at + 1] === '>' ? at + 2 : at + 1, target: 'word' };
};

/** A heredoc whose body starts on the line after the command that opened it. */
interface PendingHeredoc {
  readonly tag: string;
  readonly indented: boolean;
}

/** The index just past the heredoc bodies that start at `from`, one per opened tag in order. */
const skipHeredocBodies = (source: string, from: number, pending: readonly PendingHeredoc[]): number => {
  let position = from;
  for (const { tag, indented } of pending) {
    while (position < source.length) {
      const newline = source.indexOf('\n', position);
      const line = source.slice(position, newline === -1 ? source.length : newline);
      position = newline === -1 ? source.length : newline + 1;
      if ((indented ? line.replace(/^\t+/u, '') : line) === tag) break;
    }
  }
  return position;
};

/**
 * The simple commands of `script`, as POSIX-quoted words. Enough of the shell to read what an agent
 * writes: single and double quotes, backslash escapes, and the heredoc substitution above. Any other
 * `$`/backtick inside a word marks it expanded rather than guessing at its value.
 *
 * REDIRECTIONS ARE NOT ARGUMENTS. `2>&1`, `> /dev/null`, `>>log`, `&>out`, `< in`, `<<< "text"` and a
 * heredoc (`<<EOF … EOF`) are dropped — operator and target both — so `fy send tanna "hi" 2>&1` has the
 * words `fy send tanna hi`. A bare number is a file descriptor only when it touches the operator
 * (`2>`); `fy send tanna 2 > out` keeps its `2`.
 */
export const simpleCommands = (script: string): readonly (readonly Word[])[] => {
  const { script: source, bodies } = expandHeredocs(script);
  const commands: Word[][] = [[]];
  let text = '';
  let expanded = false;
  let open = false;
  let bare = true;
  let redirect: Redirection['target'] = 'none';
  let heredocs: PendingHeredoc[] = [];
  const current = (): Word[] => commands[commands.length - 1] as Word[];
  const end = (): void => {
    if (open) {
      if (redirect === 'none') current().push({ text, expanded });
      else if (redirect !== 'word') heredocs.push({ tag: text, indented: redirect === 'heredoc-indented' });
      redirect = 'none';
    }
    text = '';
    expanded = false;
    open = false;
    bare = true;
  };
  const placeholder = (at: number): number => {
    const close = source.indexOf('\u0000', at + 1);
    text += bodies[Number(source.slice(at + 1, close))] ?? '';
    open = true;
    bare = false;
    return close;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    const found = redirectionAt(source, index);
    if (character === '\u0000') index = placeholder(index);
    else if (character === "'") {
      const close = source.indexOf("'", index + 1);
      if (close === -1) return [];
      text += source.slice(index + 1, close);
      open = true;
      bare = false;
      index = close;
    } else if (character === '"') {
      open = true;
      bare = false;
      for (index += 1; index < source.length && source[index] !== '"'; index += 1) {
        const inner = source[index] as string;
        if (inner === '\u0000') index = placeholder(index);
        else if (inner === '\\' && /["\\$`]/u.test(source[index + 1] ?? '')) {
          text += source[index + 1];
          index += 1;
        } else {
          if (inner === '$' || inner === '`') expanded = true;
          text += inner;
        }
      }
      if (index >= source.length) return [];
    } else if (character === '\\') {
      if (source[index + 1] !== '\n') text += source[index + 1] ?? '';
      if (source[index + 1] !== '\n') {
        open = true;
        bare = false;
      }
      index += 1;
    } else if (character === ' ' || character === '\t') end();
    else if (found !== undefined) {
      if (open && bare && /^\d+$/u.test(text)) {
        text = '';
        open = false;
      }
      end();
      redirect = found.target;
      index = found.next - 1;
    } else if (OPERATORS.has(character)) {
      end();
      redirect = 'none';
      commands.push([]);
      if (character === '\n' && heredocs.length > 0) {
        index = skipHeredocBodies(source, index + 1, heredocs) - 1;
        heredocs = [];
      }
    } else {
      if (character === '$' || character === '`') expanded = true;
      text += character;
      open = true;
    }
  }
  end();
  return commands.filter(command => command.length > 0);
};


/** The binary's own name, or a path ending in it. */
const isClient = (word: string, clientName: string): boolean => word === clientName || word.endsWith(`/${clientName}`);

/**
 * Where the client starts in one simple command, or -1 when the command is not the client's. Only
 * `direnv exec <dir> fy …` may stand in front of it, so a command that merely mentions it is not one.
 */
export const clientAt = (words: readonly Word[], clientName: string): number => {
  const start = words.findIndex(word => isClient(word.text, clientName));
  const launcher = words.slice(0, start).map(word => word.text);
  const launched = start === 0 || (start === 3 && launcher[0] === 'direnv' && launcher[1] === 'exec');
  return start !== -1 && launched ? start : -1;
};
