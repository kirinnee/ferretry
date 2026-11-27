import {
  asObject,
  dependsOnSubagent,
  startsTurn,
  relocateIdentity,
  type RolloutRecord,
} from './relocation-identity.ts';

/** The Codex writers whose rollouts were exercised by `tests/realworld/relocate-resume.test.ts` (real binary, loopback model). */
const RELOCATABLE_ROLLOUT_WRITERS: ReadonlySet<string> = new Set(['0.145.0', '0.166.0', '0.170.0']);

/** A rollout's place in a Codex home: `sessions/YYYY/MM/DD/rollout-<stamp>-<id>.jsonl`, one plain relative path. */
const ROLLOUT_PATH =
  /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[0-9A-Za-z-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;

/** The conversation id a rollout path names, or `undefined` when it is not a rollout path. */
export function rolloutPathId(relPath: string): string | undefined {
  return ROLLOUT_PATH.exec(relPath)?.[1];
}

/** The rollout path a conversation that takes a new id is filed under: the same day folder and stamp, the new id. */
export function renamedRolloutPath(relPath: string, from: string, id: string): string {
  return `${relPath.slice(0, relPath.length - `${from}.jsonl`.length)}${id}.jsonl`;
}

/** The home-relative path of a rollout path's folder. */
export const rolloutFolder = (relPath: string): string => relPath.slice(0, relPath.lastIndexOf('/'));

export type Relocated =
  | { readonly kind: 'moved'; readonly text: string; readonly id: string }
  | { readonly kind: 'refused'; readonly reason: string };

const refused = (reason: string): Relocated => ({ kind: 'refused', reason });

/** The marker every launch declares inside its own home (`codexCorrelationArguments`): an absolute path the source owns. */
const SOURCE_MARKER = /((?:\/[^\s"'\\<>]+)+)\/codex-correlation\/unreachable/gu;

/**
 * A whole rollout, written on another machine, as the text of the rollout the NEW ferret resumes. Pure: nothing is read
 * or written here. The conversation keeps its id unless `id` names a new one; every work-folder field and every self id
 * is moved field by field (never a text replacement over what was said), and the source home's correlation marker is
 * replaced by a neutral one, so no path of the source's survives in a field Codex reads. Refused, with a plain sentence,
 * for a rollout written by a Codex that was not tested, one that is not records, or one that leans on a native subagent.
 */
export function relocateRollout(
  source: string,
  into: { readonly folder: string; readonly home: string; readonly id?: string },
): Relocated {
  const oldHomes = [...new Set([...source.matchAll(SOURCE_MARKER)].map(found => found[1] as string))];
  const lines = source.split('\n');
  // The unflushed last line (no newline yet) is not part of the conversation: no reader takes it.
  lines.pop();
  const records: RolloutRecord[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      const value = asObject(JSON.parse(line.replace(SOURCE_MARKER, `${into.home}/codex-correlation/relocated`)));
      if (typeof value?.type !== 'string' || asObject(value.payload) === undefined) throw new Error('not a record');
      records.push(value as RolloutRecord);
    } catch {
      return refused(`line ${index + 1} of the conversation is not a record, so it cannot be moved safely`);
    }
  }
  const headerAt = records.findIndex(record => record.type === 'session_meta');
  const header = records[headerAt];
  if (header === undefined || headerAt > 7 || typeof header.payload.id !== 'string')
    return refused('the conversation has no header Ferretry knows how to read, so it cannot be moved');
  const version = header.payload.cli_version;
  if (typeof version !== 'string' || !RELOCATABLE_ROLLOUT_WRITERS.has(version))
    return refused(
      `the conversation was written by Codex ${typeof version === 'string' ? version : '(unknown version)'}, a rollout format Ferretry has not tested, so it was not moved`,
    );
  const oldFolder = header.payload.cwd;
  if (typeof oldFolder !== 'string' || !oldFolder.startsWith('/'))
    return refused('the conversation does not name the folder it worked in, so it cannot be moved');
  if (!records.some(startsTurn))
    return refused('this conversation has no turn yet, so Codex would have nothing to resume; it was not moved');
  if (dependsOnSubagent(records))
    return refused(
      'this conversation uses a native subagent whose separate rollout cannot be moved safely, so it was not moved',
    );
  const move = {
    from: header.payload.id,
    oldFolder,
    folder: into.folder,
    oldHomes,
    home: into.home,
    ...(into.id === undefined ? {} : { id: into.id }),
  };
  const kept: string[] = [];
  for (const record of records) {
    const rewritten = relocateIdentity(record, move);
    if (rewritten.kind === 'refused') return refused(rewritten.reason);
    kept.push(JSON.stringify(rewritten.record));
  }
  return { kind: 'moved', text: `${kept.join('\n')}\n`, id: into.id ?? header.payload.id };
}
