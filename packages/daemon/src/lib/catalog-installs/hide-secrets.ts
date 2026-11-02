/**
 * "See changes" must never carry a value somebody typed in by hand (docs/catalogs.md § See changes).
 *
 * The preview is open to a ferret, and the installed copy is rebuilt from this machine's own bytes, which can hold
 * a password pasted into a server's environment or a token pasted into a skill. Both sides of the comparison, the
 * installed copy AND the offered item, go through the same rules the fleet uses before a component's text leaves
 * (`looksSecret`, `redactText`) before they are compared. Pure.
 *
 * A value that is cut out on both sides but was different on each would otherwise read as "unchanged", so the
 * offered side then says {@link HIDDEN_DIFFERENT}: a reader learns THAT it changes, never what it was.
 */
import { looksSecret } from '@ferretry/fleet';
import { announcesKey, MIN_SECRET_VALUE_LENGTH } from '@ferretry/protocol';
import type { CatalogMcpSetup, SharedCatalogItem } from '@ferretry/protocol';
import { redactText } from '../fleet/catalog.ts';

type SkillItem = Extract<SharedCatalogItem, { kind: 'skill' }>;
type McpItem = Extract<SharedCatalogItem, { kind: 'mcp' }>;

export const HIDDEN = '‹hidden›';
export const HIDDEN_DIFFERENT = '‹hidden, different›';

const WHOLE_PLACEHOLDER = /^\$\{secret:[A-Za-z0-9_.-]+\}$/u;
const INDIRECT = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})$/u;
const USER_INFO = /\/\/[^/@\s]+@/gu;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const QUERY_PARAMETER = /([?&#;])([^=&#;?\s]+)=([^&#;\s]*)/gu;
const FLAG_WITH_VALUE = /^(--?[^=\s]+)=(.+)$/u;
const LINE_BREAK = /\r\n|\r|\n/u;
const WORD_CHARACTER = /[A-Za-z0-9_]/u;
const NAME_THEN_BREAK = /^["']?([A-Za-z0-9_.-]+)["']?[:=]$/u;
const KEY_OF_ITS_OWN = /[:=]["']?$/u;
/** Longest file, in lines, that is checked for a secret split over lines; a longer one is hidden whole. */
const MAX_CHECKED_LINES = 20_000;
/** How much text after a line break is joined to the word before it when looking for a split secret. */
const SPAN = 256;
/** A line longer than this, or a word longer than {@link MAX_WORD}, is hidden whole with no pattern run on it. */
const MAX_LINE = 4096;
const MAX_WORD = 1024;

/** Whether a NAME says its value is a secret, at any length: the fleet's own rule and the catalog's own list of key words. */
const announcesSecret = (name: string): boolean =>
  looksSecret(name, 'x'.repeat(MIN_SECRET_VALUE_LENGTH)) || announcesKey(name);

const isReference = (value: string): boolean => value === '' || WHOLE_PLACEHOLDER.test(value) || INDIRECT.test(value);

/** A value beside its name that is hidden: a name that announces a secret at any length, or a value that looks like one. */
const isSecretValue = (name: string, value: string): boolean =>
  !isReference(value) && (announcesSecret(name) || looksSecret(name, value));

/**
 * Whether text is too big to be worth reading: a line over {@link MAX_LINE} or a word over {@link MAX_WORD}. Checked
 * with plain scans (linear) BEFORE any pattern runs, because the text is a publisher's, or whoever typed it here.
 */
function oversized(text: string): boolean {
  for (const line of text.split(LINE_BREAK)) {
    if (line.length > MAX_LINE) return true;
    if (line.length > MAX_WORD && line.split(/\s+/u).some(word => word.length > MAX_WORD)) return true;
  }
  return false;
}

/** Text with every secret-looking value on a line cut out, and the user info and query values of an address. */
const redacted = (text: string): string =>
  oversized(text)
    ? HIDDEN
    : redactText(
        text
          .replace(USER_INFO, `//${HIDDEN}@`)
          .replace(QUERY_PARAMETER, (whole, mark: string, name: string, value: string) =>
            isSecretValue(name, value) ? `${mark}${name}=${HIDDEN}` : whole,
          ),
        isSecretValue,
      ).text;

/**
 * `shown` (the cut text of `raw`), told apart from the other side when the raw texts differ but what is shown does
 * not: a hidden change is never drawn as no change. Only the offered side passes `there`.
 */
const marked = (shown: string, raw: string, there?: { readonly shown: string; readonly raw: string }): string =>
  there !== undefined && there.raw !== raw && there.shown === shown && shown.includes(HIDDEN)
    ? shown.replaceAll(HIDDEN, HIDDEN_DIFFERENT)
    : shown;

const significantLines = (text: string): string[] =>
  text
    .split(LINE_BREAK)
    .map(line => line.trim())
    .filter(line => line !== '');

const lastWord = (line: string): string => line.split(/\s+/u).at(-1) ?? '';

/**
 * `password:⏎hunter2`: a line that ends in a name that announces a secret and `:` or `=`, with a value on the
 * next line (a line that is a key of its own, `api_token: x`, is read on its own).
 */
function valueOnNextLine(last: string, next: string): boolean {
  const name = NAME_THEN_BREAK.exec(last)?.[1];
  const value = next.split(/\s+/u)[0] ?? '';
  return name !== undefined && announcesSecret(name) && !isReference(value) && !KEY_OF_ITS_OWN.test(value);
}

/**
 * A secret split across lines (`gh` / `p_abc…`) is no single line's secret: at each line break the last word of the
 * line (and the part of it after its last non-word character, `path/gh`) is joined to the next `SPAN` characters
 * after it and tried again. The lines are already known to be short ({@link redacted}).
 */
function splitSecret(text: string): boolean {
  const kept = significantLines(text);
  if (kept.length > MAX_CHECKED_LINES) return true;
  if (kept.some((line, index) => valueOnNextLine(lastWord(line), kept[index + 1] ?? ''))) return true;
  const lines = significantLines(text.replaceAll(HIDDEN, ''));
  for (let index = 0; index < lines.length - 1; index += 1) {
    const last = lastWord(lines[index] ?? '');
    let tail = '';
    for (let next = index + 1; next < lines.length && tail.length < SPAN; next += 1) tail += lines[next] ?? '';
    tail = tail.slice(0, SPAN);
    let start = last.length;
    while (start > 0 && WORD_CHARACTER.test(last[start - 1] ?? '')) start -= 1;
    const after = last.slice(start);
    if (NAME_THEN_BREAK.test(last)) continue;
    if (redactText(last + tail).redacted) return true;
    if (after !== last && redactText(after + tail).redacted) return true;
  }
  return false;
}

/** A skill file as it may be compared: its secret lines cut, or all of it hidden when a secret cannot be cut out line by line. */
function shownFile(text: string): string {
  if (PRIVATE_KEY_BLOCK.test(text)) return HIDDEN;
  const cut = redacted(text);
  return splitSecret(cut) ? HIDDEN : cut;
}

const shownValue = (name: string, value: string): string =>
  isReference(value) ? value : isSecretValue(name, value) ? HIDDEN : redacted(value);

/** An argument: the value of a flag that names a secret (`--password x`, `--token=x`) at any length, else its own lines cut. */
function shownArg(arg: string, previous: string | undefined): string {
  const inline = FLAG_WITH_VALUE.exec(arg);
  if (inline !== null) {
    const [, flag = '', value = ''] = inline;
    return announcesSecret(flag) && !isReference(value) ? `${flag}=${HIDDEN}` : redacted(arg);
  }
  const named = previous !== undefined && previous.startsWith('-') && !previous.includes('=');
  return named && announcesSecret(previous) && !arg.startsWith('-') && !isReference(arg) ? HIDDEN : redacted(arg);
}

const shownArgs = (args: readonly string[]): string[] => args.map((arg, index) => shownArg(arg, args[index - 1]));

/** `was` is the installed setup, passed only for the offered one. */
function hiddenSetup(setup: CatalogMcpSetup, was?: CatalogMcpSetup): CatalogMcpSetup {
  const pair = (shown: string, raw: string, other: string | undefined, otherShown: string) =>
    marked(shown, raw, was === undefined || other === undefined ? undefined : { shown: otherShown, raw: other });
  if (setup.transport === 'url') {
    const there = was?.transport === 'url' ? was.url : undefined;
    return { ...setup, url: pair(redacted(setup.url), setup.url, there, there === undefined ? '' : redacted(there)) };
  }
  const old = was?.transport === 'command' ? was : undefined;
  const oldArgs = old === undefined ? [] : shownArgs(old.args);
  const args = shownArgs(setup.args);
  return {
    ...setup,
    command: pair(redacted(setup.command), setup.command, old?.command, old === undefined ? '' : redacted(old.command)),
    args: args.map((shown, index) => pair(shown, setup.args[index] ?? '', old?.args[index], oldArgs[index] ?? '')),
    env: Object.fromEntries(
      Object.entries(setup.env).map(([name, text]) => {
        const there = old?.env[name];
        return [name, pair(shownValue(name, text), text, there, there === undefined ? '' : shownValue(name, there))];
      }),
    ),
  };
}

const hiddenServers = (installed: McpItem, offered: McpItem): [McpItem, McpItem] => [
  { ...installed, mcp: hiddenSetup(installed.mcp) },
  { ...offered, mcp: hiddenSetup(offered.mcp, installed.mcp) },
];

function hiddenFiles(installed: SkillItem, offered: SkillItem): [SkillItem, SkillItem] {
  const seen = new Map(installed.skill.files.map(file => [file.path, file.content]));
  const side = (item: SkillItem, against?: ReadonlyMap<string, string>): SkillItem => ({
    ...item,
    skill: {
      ...item.skill,
      files: item.skill.files.map(file => {
        const shown = shownFile(file.content);
        const there = against?.get(file.path);
        return {
          ...file,
          content: marked(
            shown,
            file.content,
            there === undefined ? undefined : { shown: shownFile(there), raw: there },
          ),
        };
      }),
    },
  });
  return [side(installed), side(offered, seen)];
}

/** The installed copy and the offered item, both with every hand-typed secret cut out, ready to compare. */
export function hideSecrets(
  installed: SharedCatalogItem,
  offered: SharedCatalogItem,
): [SharedCatalogItem, SharedCatalogItem] {
  if (installed.kind === 'skill' && offered.kind === 'skill') return hiddenFiles(installed, offered);
  if (installed.kind === 'mcp' && offered.kind === 'mcp') return hiddenServers(installed, offered);
  return [installed, offered];
}
