import type { LaunchSpec, PackedConversation } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import { claudeProjectFolder, claudeTranscriptPath, isConversationId } from '../../lib/harness/claude-path.ts';
import { hasRealTurn, type Json, recordMover, sourceFolders } from '../../lib/harness/relocate-records.ts';
import { type ClaudeCore, claudeHome, type Serves } from './core.ts';
import { includesSubagent, type Line, linesOf, MAX_FORK_BYTES, sourceBytes } from './fork.ts';
import { historyPart } from './history.ts';
import { ensureHome, poolHistory, requirePrivateChain } from './home.ts';
import { resolveTranscriptFile } from './transcript.ts';

/**
 * The Claude Code versions a conversation was measured to resume on, each one exactly (docs/migration-cross-harness.md,
 * "Versions": 2.1.281 and 2.1.304; 2.1.327 by the real-CLI resume in tests/integration/claude-harness-relocate.test.ts).
 * A version between them was never run, so it is refused: a range would admit 2.1.399 on the strength of 2.1.304.
 */
const TESTED_CLAUDE_VERSIONS: ReadonlySet<string> = new Set(['2.1.281', '2.1.304', '2.1.327']);
const PACKED_PATH = /^projects\/([^/]+)\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\.jsonl$/u;

type Refusal = Result<never, { readonly reason: string }>;
const refuse = (reason: string): Refusal => err({ reason });

/** The folder the source worktree was: the recorded `cwd` Claude spells as the packed folder, else the first one recorded. */
function sourceFolder(lines: readonly Line[], spelling: string): string | undefined {
  const cwds = lines.flatMap(({ record }) => (typeof record?.cwd === 'string' ? [record.cwd] : []));
  return cwds.find(cwd => claudeProjectFolder(cwd) === spelling) ?? cwds[0];
}

const recordsOf = (lines: readonly Line[]): Json[] =>
  lines.flatMap(({ record }) => (record === undefined ? [] : [record]));

/** What this home's `projects` is: the link to THIS machine's pool, some other link, or not a link at all (absent or a folder). */
type ProjectsLink = 'pool' | 'foreign' | 'unlinked';

/**
 * Whether this home's `projects` is the link to THIS machine's pool: a link that resolves to the pool's real `projects`
 * folder. Claude reads and writes through that link, so a conversation written into the pool is found by Claude only
 * if it is the link the launch made; any other link would make the move claim a conversation Claude cannot see. A read
 * only: it never changes the home or the pool.
 */
async function projectsLink(core: ClaudeCore, spec: LaunchSpec): Promise<ProjectsLink> {
  const home = claudeHome(core, spec.ferret);
  const link = home.resolve('projects');
  if (!link.ok) return 'foreign';
  const there = await home.lstat(link.value);
  if (there?.kind !== 'symlink') return there === undefined || there.kind === 'directory' ? 'unlinked' : 'foreign';
  const resolve = core.deps.resolveLink;
  const pool = core.deps.roots.historyPool();
  const projects = pool.resolve('projects');
  if (resolve === undefined || !projects.ok) return 'foreign';
  const [real, leads] = await Promise.all([
    pool.realPath(projects.value).catch(() => undefined),
    resolve(String(link.value)),
  ]);
  return real !== undefined && leads === String(real) ? 'pool' : 'foreign';
}

const NOT_POOLED =
  "this ferret's conversations folder is not linked to this machine's shared history, so Claude Code would not find the moved conversation there and nothing was written";

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

export const relocationPart = (core: ClaudeCore): Serves<'packConversation' | 'unpackConversation'> => {
  /** One plain sentence when the installed Claude Code is not one a move was tested on; `undefined` when it is. */
  async function untested(): Promise<string | undefined> {
    const location = await core.deps.location.locate();
    if (location.outcome !== 'located')
      return 'Claude Code was not found on this machine, so a moved conversation cannot be checked against it.';
    const version = await core.deps.probe.version(location.path);
    if (version.state !== 'ok') return `Claude Code at ${location.path} could not say its version: ${version.reason}`;
    return TESTED_CLAUDE_VERSIONS.has(version.version)
      ? undefined
      : `Claude Code ${version.version} was not tested for moving a conversation (tested: ${[...TESTED_CLAUDE_VERSIONS].join(', ')}), so nothing was written.`;
  }

  return {
    /**
     * This ferret's own conversation file byte for byte, read through the pool link the ferret resumes by (the same no-link
     * open a fork uses). Only that one file: a conversation that ran a subagent has a second transcript this form cannot
     * carry, so it is refused as a fork refuses it.
     */
    async packConversation(ferret: FerretId): Promise<Result<PackedConversation, { readonly reason: string }>> {
      try {
        const source = await resolveTranscriptFile(core, ferret);
        if (source === undefined) return refuse('this ferret has no conversation on disk to move');
        const bytes = await sourceBytes(source.home, source.file, 'move');
        const lines = linesOf(bytes);
        if (includesSubagent(lines))
          return refuse('this conversation ran a subagent whose separate transcript cannot be moved with it');
        if (!hasRealTurn(recordsOf(lines)))
          return refuse('this conversation has no turn in it yet (only notes), so Claude Code could not resume it');
        const folder = source.file.slice(0, source.file.lastIndexOf('/'));
        const spelling = folder.slice(folder.lastIndexOf('/') + 1);
        return ok({ bytes, relPath: `projects/${spelling}/${source.conversation}.jsonl` });
      } catch (error) {
        return refuse(error instanceof Error ? error.message : 'the conversation could not be read');
      }
    },

    /**
     * Writes a packed conversation into THIS machine's shared history under the spelling of `spec.folder`, where the
     * new ferret's `projects` link reaches it. Everything that can refuse is checked before the first write; if the
     * written file then does not prove, it is removed again.
     */
    async unpackConversation(
      spec: LaunchSpec,
      packed: PackedConversation,
    ): Promise<Result<{ readonly conversation: string }, { readonly reason: string }>> {
      try {
        const named = PACKED_PATH.exec(packed.relPath);
        if (named === null) return refuse('that is not the path of a Claude Code conversation file');
        const [, spelling = '', oldId = ''] = named;
        const folder = String(spec.folder);
        if (!folder.startsWith('/')) return refuse('the folder to move the conversation into must be an absolute path');
        const newId = spec.harnessConversation ?? oldId;
        if (!isConversationId(newId)) return refuse('the conversation id must be one plain name');
        if (packed.bytes.length > MAX_FORK_BYTES) return refuse('that conversation is too large to move (over 256 MB)');
        const lines = linesOf(packed.bytes);
        if (lines.length === 0 || lines.some(line => line.record === undefined))
          return refuse('that is not a whole Claude Code conversation file');
        if (includesSubagent(lines))
          return refuse('that conversation ran a subagent whose separate transcript is not in the pack');
        const records = recordsOf(lines);
        if (!hasRealTurn(records))
          return refuse('that conversation has no turn in it yet (only notes), so Claude Code could not resume it');
        const sentence = await untested();
        if (sentence !== undefined) return refuse(sentence);

        const move = recordMover({
          from: sourceFolders(records, sourceFolder(lines, spelling)),
          to: folder.replace(/\/+$/u, '') || '/',
          home: String(spec.home),
          oldId,
          newId,
          spell: claudeProjectFolder,
        });
        const encoder = new TextEncoder();
        const parts: Uint8Array[] = [];
        for (const { bytes, record } of lines) {
          const moved =
            record === undefined ? { refusal: 'that is not a whole Claude Code conversation file' } : move(record);
          if ('refusal' in moved) return refuse(moved.refusal);
          if ('drop' in moved) continue;
          parts.push(moved.changed ? encoder.encode(`${JSON.stringify(moved.record)}\n`) : bytes);
        }
        const body = joined(parts);

        const home = await ensureHome(core, spec);
        await requirePrivateChain(home);
        // A link to anywhere but the pool refuses HERE, before poolHistory moves the home's own history into the pool.
        if ((await projectsLink(core, spec)) === 'foreign') return refuse(NOT_POOLED);
        await poolHistory(core, spec.ferret);
        if ((await projectsLink(core, spec)) !== 'pool') return refuse(NOT_POOLED);
        const pool = core.deps.roots.historyPool();
        const relative = claudeTranscriptPath(folder, newId);
        const file = pool.resolve(relative);
        const directory = pool.resolve(relative.slice(0, relative.lastIndexOf('/')));
        if (!file.ok || !directory.ok) return refuse('the conversation would be outside the folders Ferretry may use');
        await pool.makeDirectory(directory.value, { mode: 0o700 });
        await pool.writeBytes(file.value, body, { exclusive: true });
        // `hasConversation` is the proof the launch resumes by; a file that does not prove is taken out again.
        const proved = await historyPart(core).hasConversation(spec, newId);
        if (proved !== true) {
          await pool.remove(file.value).catch(() => undefined);
          return refuse(
            'the moved conversation was written but Claude Code would not find it, so it was taken out again',
          );
        }
        return ok({ conversation: newId });
      } catch (error) {
        return refuse(error instanceof Error ? error.message : 'the conversation could not be written');
      }
    },
  };
};
