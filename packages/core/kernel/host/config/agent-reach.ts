/**
 * Which configuration files an AGENT may name: the 5.0 files that now hold what today's agent could reach (RULING on
 * C2 and the round-2 reach table), and no more. Today's door took a path only if `classifyConfigPath` knew it: 8 single
 * files, 5 named-file folders and `components/<kind>/`, 14 entries. Each is mapped here to the file that holds the same
 * content in 5.0, ONLY where that file's `loosens` is at least as strict as today's rule for the same content (an
 * agent's loosening must be HELD, never applied), and ONLY where the file holds nothing today's agent could not reach
 * — with one accepted exception: `agenda.yaml` also holds `deadlineWarnHours` (today in `daemon.json`), which moves
 * only when a deadline warning buzzes, no spend and no authority (docs/config-files.md, the agent's tools).
 * Also, by owner decision (!A525): `harness-claude-code.yaml` and `harness-codex.yaml` (today machine.yaml's agent
 * permissions, plus the harness `binary` and `searchPaths` that lived in `daemon.json`, out of an agent's reach). Each
 * plugin's `loosens` holds a looser permission mode AND any change of `binary` or `searchPaths`, since a path names the
 * program every new ferret launches; an agent's edit of either is HELD through the same writer as every other file.
 * Also `browsers.yaml` (machine.yaml's browser mode and proxy: Browsers' `loosens` holds a new or re-aimed proxy, as today
 * did) and `usage.yaml` (machine.yaml's time zone and public feed: Usage's `loosens` holds ANY time-zone change and the
 * feed turned on, as today did).
 * Never `gate.yaml`, `plugins.yaml` or any file the 5.0 plugins added with no today equivalent: widening that is the
 * owner's decision, not a side effect of the declared-file reader.
 *
 * Also, by owner ruling (!A525 item 9, "agents may write config/instructions and codex/hooks behind an owner hold"):
 * `instructions/<n>.yaml` (Runtimes; today's `components/instructions/<n>`) and `codex/hooks/<n>.yaml` (Codex; today's
 * Codex `components/hooks/<n>`). Each plugin's `loosens` HOLDS EVERY add and EVERY change by an agent for the owner (it is
 * not `neverLoosens`: instructions are what a ferret is told and a hook is a shell command, so no agent's write of either
 * is ever applied unseen). The owner's write through fy, the app or PUT /v1/config/file is never held; a hand edit or a
 * file copied onto disk is held like any unacknowledged edit until `fy config confirm`. Whoever adds a folder here must
 * give its def a `loosens` that holds every change.
 *
 * NOT MAPPED, a declared GAP (docs/config-files.md, the agent's tools):
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
  // Owner decision !A525: a permission-mode loosening and any binary/searchPaths change is held by the plugin's rule.
  ['harness-claude-code.yaml', "machine.yaml's agent permissions, and the harness binary and searchPaths (held)"],
  ['harness-codex.yaml', "machine.yaml's agent permissions, and the harness binary and searchPaths (held)"],
  // Each one's `loosens` holds what today's did: a new or re-aimed proxy; any time-zone change and the public feed on.
  ['browsers.yaml', "machine.yaml's browser mode and proxy (a new or re-aimed proxy is held)"],
  ['usage.yaml', "machine.yaml's time zone and public feed (a time-zone change and the feed on are held)"],
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
  // Owner ruling !A525 item 9: each def's `loosens` holds EVERY agent add or change for the owner.
  ['instructions', 'components/instructions/<name> (every add or change is held)'],
  ['codex/hooks', "Codex's components/hooks/<name> (every add or change is held)"],
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
