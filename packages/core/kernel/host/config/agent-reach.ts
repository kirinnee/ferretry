/**
 * Which configuration files an AGENT may name: exactly the ones today's agent could (RULING on C2). Today's door took a
 * path only if `classifyConfigPath` knew it, so the agent never reached `plugins.yaml`, `gate.yaml` or any file the
 * 5.0 plugins added; widening that is the owner's decision, not a side effect of the new declared-file reader.
 *
 * Copied from today's `classifyConfigPath` (path shape only; the kind it names is not needed here). Pure and total over
 * every string.
 */

const EXTENSION = '.yaml';

/** Today's singleton files. */
const SINGLETONS: ReadonlySet<string> = new Set([
  'machine',
  'warden',
  'learning',
  'voice',
  'pack',
  'limits',
  'models-guide',
  'account-defaults',
]);

/** Today's named-file directories. */
const NAMED_DIRECTORIES: ReadonlySet<string> = new Set(['logins', 'profiles', 'runtimes', 'presets', 'models']);

/** Today's component kinds (`components/<kind>/<name>.yaml`). */
const COMPONENT_KINDS: ReadonlySet<string> = new Set([
  'instructions',
  'mcp',
  'skills',
  'settings',
  'hooks',
  'modelSets',
]);

/** A file name's stem: no separator, no leading dot, no traversal, no control character, at most 64 long. */
const usableStem = (stem: string): boolean =>
  stem.length > 0 &&
  stem.length <= 64 &&
  !stem.startsWith('.') &&
  !stem.includes('..') &&
  !/[/\\]/u.test(stem) &&
  ![...stem].some(character => (character.codePointAt(0) ?? 0) < 0x20);

/** Whether today's agent could have named this path (relative to the config directory). */
export function agentMayName(relativePath: string): boolean {
  if (!relativePath.endsWith(EXTENSION)) return false;
  const parts = relativePath.slice(0, -EXTENSION.length).split('/');
  if (parts.length === 1) return SINGLETONS.has(parts[0] as string);
  if (parts.length === 2) return NAMED_DIRECTORIES.has(parts[0] as string) && usableStem(parts[1] as string);
  if (parts.length === 3)
    return parts[0] === 'components' && COMPONENT_KINDS.has(parts[1] as string) && usableStem(parts[2] as string);
  return false;
}

/**
 * Today's refusal for a path outside the reach (`400 invalid_request`, from the body schema every call passed
 * through): the words are today's, word for word.
 */
export const AGENT_REACH_WORDS =
  'not a Ferretry configuration file — use machine.yaml, warden.yaml, learning.yaml, voice.yaml, logins/<id>.yaml, profiles/<name>.yaml, runtimes/<name>.yaml or components/<kind>/<name>.yaml';
