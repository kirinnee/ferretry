/**
 * WHICH SHELL SCRIPTS A CONTRIBUTING PLUGIN MAY SEE (`row-slots.tsx`). A script is offered only when the WHOLE of it is
 * exactly ONE simple command whose program is the product's CLI (`fy …`, `/usr/local/bin/fy …`, `direnv exec . fy …`).
 *
 * This is deliberately not the loose reader a peer send is found by (`simpleCommands`): that reader splits a script into
 * its commands and lets a caller pick the one it wants, so a script with one `fy` among others would be read as an `fy`
 * script. Here every other shape fails closed — whatever the script does besides one plain command, the command and what
 * it printed stay inside Conversation. Not allowed, anywhere outside quotes: a pipe, a list (`;` `&&` `||`), `&`, a
 * newline-separated second command, a subshell or group, a redirect, a backtick, and any `$` (a variable or a command
 * substitution). Inside double quotes a `$` or backtick is refused too.
 *
 * The one expansion allowed is the long-message form `"$(cat <<'TAG' … TAG)"` with a QUOTED tag: a quoted heredoc is
 * taken literally by the shell, so it can run nothing; a bare tag expands `$(…)` in its body, so it is refused. The body
 * ends at the first line that is the tag, exactly as the shell ends it, and only whitespace and the closing `)` may follow.
 *
 * What this proves is the program's NAME (`fy`), not its identity: a path ending in `/fy` is accepted, as a bare `fy` is
 * a PATH lookup too. Syntax cannot tell more.
 */
import { clientAt } from './peer-delivery.ts';

const HEREDOC_OPEN = /\$\(cat <<(-?)[ ]*(?:'(\w+)'|"(\w+)")\n/y;

/** Where the quoted-tag heredoc substitution starting at `at` ends (just past its `)`), or `undefined` when none is there. */
const heredocEnd = (source: string, at: number): number | undefined => {
  HEREDOC_OPEN.lastIndex = at;
  const open = HEREDOC_OPEN.exec(source);
  if (open === null) return undefined;
  const tag = open[2] ?? open[3];
  const indented = open[1] === '-';
  let position = HEREDOC_OPEN.lastIndex;
  for (;;) {
    const newline = source.indexOf('\n', position);
    if (newline === -1) return undefined;
    const line = source.slice(position, newline);
    if ((indented ? line.replace(/^\t+/u, '') : line) === tag) {
      const close = /^\s*\)/u.exec(source.slice(newline + 1));
      return close === null ? undefined : newline + 1 + close[0].length;
    }
    position = newline + 1;
  }
};

/** Characters that, outside quotes, make a script more than one plain command (or a command that is not plain). */
const STRUCTURE = new Set([';', '&', '|', '<', '>', '(', ')', '`', '\n', '\r', '$']);

/** The words of `script` when it is ONE plain simple command with nothing the shell would expand or chain; else `undefined`. */
const plainWords = (script: string): readonly string[] | undefined => {
  const source = script.trim();
  const words: string[] = [];
  let text = '';
  let open = false;
  let mode: 'plain' | 'single' | 'double' = 'plain';
  const end = (): void => {
    if (open) words.push(text);
    text = '';
    open = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    if (mode === 'single') {
      if (character === "'") mode = 'plain';
      else text += character;
    } else if (character === '$' && source.startsWith('$(', index)) {
      const next = heredocEnd(source, index);
      if (next === undefined) return undefined;
      text += '\u0001';
      open = true;
      index = next - 1;
    } else if (mode === 'double') {
      if (character === '"') mode = 'plain';
      else if (character === '\\') {
        const escaped = source[index + 1];
        if (escaped === undefined) return undefined;
        text += escaped;
        index += 1;
      } else if (character === '$' || character === '`') return undefined;
      else text += character;
    } else if (character === ' ' || character === '\t') end();
    else if (character === "'" || character === '"') {
      mode = character === "'" ? 'single' : 'double';
      open = true;
    } else if (character === '\\') {
      const escaped = source[index + 1];
      if (escaped === undefined || escaped === '\n' || escaped === '\r') return undefined;
      text += escaped;
      open = true;
      index += 1;
    } else if (STRUCTURE.has(character)) return undefined;
    else {
      text += character;
      open = true;
    }
  }
  if (mode !== 'plain') return undefined;
  end();
  return words;
};

/** True only when the whole of `script` is one plain simple command that runs `clientName` (see the file comment). */
export const isSoleClientCommand = (script: string, clientName: string): boolean => {
  if (!script.includes(clientName)) return false;
  const words = plainWords(script);
  return (
    words !== undefined &&
    clientAt(
      words.map(text => ({ text, expanded: false })),
      clientName,
    ) !== -1
  );
};
