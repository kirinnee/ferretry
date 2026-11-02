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
import type { CatalogMcpSetup, SharedCatalogItem } from '@ferretry/protocol';
import { redactText } from '../fleet/catalog.ts';

type SkillItem = Extract<SharedCatalogItem, { kind: 'skill' }>;
type McpItem = Extract<SharedCatalogItem, { kind: 'mcp' }>;

export const HIDDEN = '‹hidden›';
export const HIDDEN_DIFFERENT = '‹hidden, different›';

const WHOLE_PLACEHOLDER = /^\$\{secret:[A-Za-z0-9_.-]+\}$/u;
const USER_INFO = /\/\/[^/@\s]+@/gu;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const QUERY_PARAMETER = /([?&#;])([^=&#;\s]+)=([^&#;\s]*)/gu;
const LINE_BREAKS = /\s*[\r\n]+\s*/gu;

/** Text with every secret-looking value on a line cut out, and the user info and query values of an address. */
const redacted = (text: string): string =>
  redactText(
    text
      .replace(USER_INFO, `//${HIDDEN}@`)
      .replace(QUERY_PARAMETER, (whole, mark: string, name: string, value: string) =>
        looksSecret(name, value) ? `${mark}${name}=${HIDDEN}` : whole,
      ),
  ).text;

/** How a skill file's text must be shown: as it is, with its secret lines cut, or not at all. */
type FileText = { readonly how: 'plain' | 'lines'; readonly text: string } | { readonly how: 'whole' };

/**
 * A secret split across lines (`gh` / `p_abc…`) is no single line's secret. So after the lines that hold one are
 * cut, a file whose remaining lines JOINED still hold one, or that holds a private key block, is hidden whole.
 */
function fileText(text: string): FileText {
  if (PRIVATE_KEY_BLOCK.test(text)) return { how: 'whole' };
  const cut = redacted(text);
  if (redactText(cut.replaceAll(HIDDEN, '').replace(LINE_BREAKS, '')).redacted) return { how: 'whole' };
  return cut === text ? { how: 'plain', text } : { how: 'lines', text: cut };
}

const hiddenEnvValue = (name: string, value: string): string =>
  WHOLE_PLACEHOLDER.test(value) || !looksSecret(name, value) ? value : HIDDEN;

/** `was` is the other side as it is: a value both sides cut out but that is not the same on both is marked. */
function hiddenSetup(setup: CatalogMcpSetup, was?: CatalogMcpSetup): CatalogMcpSetup {
  if (setup.transport === 'url') return { ...setup, url: redacted(setup.url) };
  const before = was?.transport === 'command' ? was.env : {};
  const value = (name: string, text: string): string => {
    const cut = hiddenEnvValue(name, text);
    const there = before[name];
    return cut === HIDDEN && there !== undefined && there !== text && hiddenEnvValue(name, there) === HIDDEN
      ? HIDDEN_DIFFERENT
      : cut;
  };
  return {
    ...setup,
    command: redacted(setup.command),
    args: setup.args.map(redacted),
    env: Object.fromEntries(Object.entries(setup.env).map(([name, text]) => [name, value(name, text)])),
  };
}

const hiddenServers = (installed: McpItem, offered: McpItem): [McpItem, McpItem] => [
  { ...installed, mcp: hiddenSetup(installed.mcp) },
  { ...offered, mcp: hiddenSetup(offered.mcp, installed.mcp) },
];

function hiddenFiles(installed: SkillItem, offered: SkillItem): [SkillItem, SkillItem] {
  const seen = new Map(installed.skill.files.map(file => [file.path, file.content]));
  const wanted = new Map(offered.skill.files.map(file => [file.path, file.content]));
  const shown = (side: SkillItem, other: ReadonlyMap<string, string>, first: boolean): SkillItem => ({
    ...side,
    skill: {
      ...side.skill,
      files: side.skill.files.map(file => {
        const text = fileText(file.content);
        if (text.how !== 'whole') return { ...file, content: text.text };
        const there = other.get(file.path);
        const differs = there !== undefined && there !== file.content && fileText(there).how === 'whole';
        return { ...file, content: differs && !first ? HIDDEN_DIFFERENT : HIDDEN };
      }),
    },
  });
  return [shown(installed, wanted, true), shown(offered, seen, false)];
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
