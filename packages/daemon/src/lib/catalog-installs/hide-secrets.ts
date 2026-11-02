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
import { MIN_SECRET_VALUE_LENGTH } from '@ferretry/protocol';
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
const QUERY_PARAMETER = /([?&#;])([^=&#;\s]+)=([^&#;\s]*)/gu;
const FLAG_WITH_VALUE = /^(--?[^=\s]+)=(.+)$/u;
/** Longest file, in lines, that is checked for a secret split over lines; a longer one is hidden whole. */
const MAX_CHECKED_LINES = 20_000;
/** How much text after a line break is joined to the word before it when looking for a split secret. */
const SPAN = 256;

/** Whether a NAME says its value is a secret, at any length: the fleet's own rule, asked with a value long enough. */
const announcesSecret = (name: string): boolean => looksSecret(name, 'x'.repeat(MIN_SECRET_VALUE_LENGTH));

const isReference = (value: string): boolean => value === '' || WHOLE_PLACEHOLDER.test(value) || INDIRECT.test(value);

/** Text with every secret-looking value on a line cut out, and the user info and query values of an address. */
const redacted = (text: string): string =>
  redactText(
    text
      .replace(USER_INFO, `//${HIDDEN}@`)
      .replace(QUERY_PARAMETER, (whole, mark: string, name: string, value: string) =>
        looksSecret(name, value) ? `${mark}${name}=${HIDDEN}` : whole,
      ),
  ).text;

/**
 * `shown` (the cut text of `raw`), told apart from the other side when the raw texts differ but what is shown does
 * not: a hidden change is never drawn as no change. Only the offered side passes `there`.
 */
const marked = (shown: string, raw: string, there?: { readonly shown: string; readonly raw: string }): string =>
  there !== undefined && there.raw !== raw && there.shown === shown && shown.includes(HIDDEN)
    ? shown.replaceAll(HIDDEN, HIDDEN_DIFFERENT)
    : shown;

/**
 * A secret split across lines (`gh` / `p_abc…`) is no single line's secret: at each line break the last word of the
 * line is joined to the text after it and tried again.
 */
function splitSecret(text: string): boolean {
  const lines = text.replaceAll(HIDDEN, '').split(/\r?\n/u);
  if (lines.length > MAX_CHECKED_LINES) return true;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const last = (lines[index] ?? '').split(/\s+/u).at(-1) ?? '';
    if (last === '') continue;
    let tail = '';
    for (let next = index + 1; next < lines.length && tail.length < SPAN; next += 1) tail += (lines[next] ?? '').trim();
    if (redactText(last + tail).redacted) return true;
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
  isReference(value) ? value : announcesSecret(name) || looksSecret(name, value) ? HIDDEN : redacted(value);

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
