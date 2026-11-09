/**
 * Which configuration files an AGENT may name: the 5.0 files that now hold what today's agent could reach (RULING on
 * C2 and the round-2 reach table), and no more. Today's door took a path only if `classifyConfigPath` knew it: 8 single
 * files, 5 named-file folders and `components/<kind>/`, 14 entries. Each is mapped here to the file that holds the same
 * content in 5.0, ONLY where that file's `loosens` is at least as strict as today's rule for the same content (an
 * agent's loosening must be HELD, never applied), and ONLY where the file holds nothing today's agent could not reach
 * — with one accepted exception: `agenda.yaml` also holds `deadlineWarnHours` (today in `daemon.json`), which moves
 * only when a deadline warning buzzes, no spend and no authority (docs/config-files.md, the agent's tools).
 * Never `gate.yaml`, `plugins.yaml` or any file the 5.0 plugins added with no today equivalent: widening that is the
 * owner's decision, not a side effect of the declared-file reader.
 *
 * NOT MAPPED, each a declared GAP (docs/config-files.md, the agent's tools):
 * - `browsers.yaml` (today machine.yaml's browser mode, proxy and ports): its `loosens` holds nothing, and today a new or
 *   re-aimed browser proxy was held. Mapped the day Browsers ports `browserProxyLoosening`.
 * - `usage.yaml` (today machine.yaml's time zone and public feed): a time-zone change is not held, and today it was
 *   (it moves when budgets reset). Mapped the day Usage ports the zone rule.
 * - `harness-claude-code.yaml`, `harness-codex.yaml` (today machine.yaml's agent permissions): each also holds the
 *   harness `binary` and `searchPaths`, which today lived in `daemon.json` where no agent reached, and its `loosens`
 *   judges only the permission mode. Mapping it would let an agent choose the program every new ferret launches.
 * - `components/instructions/<n>` and `components/hooks/<n>` of Codex: now `config/instructions/<n>.yaml` (Runtimes) and
 *   `config/codex/hooks/<n>.yaml` (Codex), which plugins DO declare, but are left out on purpose. Their `neverLoosens` holds
 *   nothing (as in v4), so mapping them would let an agent add agent instructions and shell hook commands with no owner
 *   hold. Today's `claude-code/hooks` is mapped (above); mapping these two is the owner's decision, not a side effect.
 * - `presets/<n>.yaml`: no declared successor (Logins to rule whether `endpoints/` is one).
 *
 * Pure and total over every string.
 */

const EXTENSION = '.yaml';

/** The single files, each with the entry of today's it holds. */
const FILES: ReadonlyMap<string, string> = new Map([
  ['warden.yaml', 'warden.yaml'],
  ['voice.yaml', 'voice.yaml'],
  ['limits.yaml', "limits.yaml, and machine.yaml's agent-control switches"],
  ['lessons.yaml', 'learning.yaml'],
  ['packs.yaml', 'pack.yaml and models-guide.yaml'],
  ['accounts.yaml', 'account-defaults.yaml'],
  ['runtimes.yaml', "machine.yaml's default runtime"],
  ['agenda.yaml', "machine.yaml's agenda mode and agenda check"],
  // Today's machine.yaml `conversations.listComputer` ("Keep in sync", docs/migration/v4-formats.md): no rule of
  // today's judged it, and 5.0's `neverLoosens` holds nothing either, so parity maps it.
  ['conversation.yaml', "machine.yaml's conversations.listComputer (keep in sync)"],
]);

/** The named-file folders (`<folder>/<name>.yaml`), each with the entry of today's it holds. */
const FOLDERS: ReadonlyMap<string, string> = new Map([
  ['logins', 'logins/<id>.yaml'],
  ['profiles', 'profiles/<name>.yaml'],
  ['runtimes', 'runtimes/<name>.yaml'],
  ['models', 'models/<name>.yaml'],
  ['mcp', 'components/mcp/<name>'],
  ['skills', 'components/skills/<name>'],
  ['claude-code/settings', 'components/settings/<name>'],
  ['codex/settings', 'components/settings/<name>'],
  ['claude-code/hooks', 'components/hooks/<name>'],
  ['model-sets', 'components/modelSets/<name>'],
]);

/** A file name's stem: no separator, no leading dot, no traversal, no control character, at most 64 long. */
const usableStem = (stem: string): boolean =>
  stem.length > 0 &&
  stem.length <= 64 &&
  !stem.startsWith('.') &&
  !stem.includes('..') &&
  !/[/\\]/u.test(stem) &&
  ![...stem].some(character => (character.codePointAt(0) ?? 0) < 0x20);

/** Whether an agent may name this path (relative to the config directory): one of today's entries, in 5.0's name. */
export function agentMayName(relativePath: string): boolean {
  if (FILES.has(relativePath)) return true;
  if (!relativePath.endsWith(EXTENSION)) return false;
  const cut = relativePath.lastIndexOf('/');
  if (cut <= 0) return false;
  return FOLDERS.has(relativePath.slice(0, cut)) && usableStem(relativePath.slice(cut + 1, -EXTENSION.length));
}

/**
 * Today's refusal for a path outside the reach (`400 invalid_request`, from the body schema every call passed
 * through): the words are today's, word for word.
 */
export const AGENT_REACH_WORDS =
  'not a Ferretry configuration file — use machine.yaml, warden.yaml, learning.yaml, voice.yaml, logins/<id>.yaml, profiles/<name>.yaml, runtimes/<name>.yaml or components/<kind>/<name>.yaml';
