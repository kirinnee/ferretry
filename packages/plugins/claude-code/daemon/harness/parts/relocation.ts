import type { LaunchSpec, PackedConversation, UnpackedConversation } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import { claudeTranscriptPath, isConversationId } from '../../lib/harness/claude-path.ts';
import type { ClaudeCore, Serves } from './core.ts';
import { asObject, includesSubagent, type Json, type Line, linesOf, MAX_FORK_BYTES, sourceBytes } from './fork.ts';
import { historyPart } from './history.ts';
import { ensureHome, poolHistory, requirePrivateChain } from './home.ts';
import { resolveTranscriptFile } from './transcript.ts';

/** The Claude Code versions a conversation was measured to resume on (docs/migration-cross-harness.md, "Versions"). */
const TESTED_CLAUDE_VERSION = /^2\.1\.[23]\d\d$/u;
const PACKED_PATH = /^projects\/([^/]+)\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\.jsonl$/u;
/** The keys a record uses for a folder of the work tree, at any depth (a `cwd` on every record, a `worktreeSession`'s paths). */
const FOLDER_KEYS = new Set(['cwd', 'originalCwd', 'worktreePath']);
/** The keys a record uses for the conversation's own id, at any depth. A `forkedFrom` id names ANOTHER conversation and is kept. */
const SELF_ID_KEYS = new Set(['sessionId', 'session_id']);

type Refusal = Result<never, { readonly reason: string }>;
const refuse = (reason: string): Refusal => err({ reason });

/** `value` moved from the `from` tree to the `to` tree, or `undefined` when it is not inside `from` (a folder elsewhere is kept). */
function moved(value: string, from: string, to: string): string | undefined {
  if (value === from) return to;
  return value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : undefined;
}

/** Rewrites folders and self ids in place, at any depth; true when something changed. */
function rewriteRecord(value: unknown, plan: { from?: string; to: string; oldId: string; newId: string }): boolean {
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) changed = rewriteRecord(item, plan) || changed;
    return changed;
  }
  const object = asObject(value);
  if (object === undefined) return false;
  for (const [key, inner] of Object.entries(object)) {
    if (typeof inner === 'string') {
      const next =
        FOLDER_KEYS.has(key) && plan.from !== undefined
          ? moved(inner, plan.from, plan.to)
          : SELF_ID_KEYS.has(key) && inner === plan.oldId && plan.newId !== plan.oldId
            ? plan.newId
            : undefined;
      if (next !== undefined && next !== inner) {
        object[key] = next;
        changed = true;
      }
    } else changed = rewriteRecord(inner, plan) || changed;
  }
  return changed;
}

/** The folder the source worktree was: the recorded `cwd` Claude spells as the packed folder, else the first one recorded. */
function sourceFolder(lines: readonly Line[], spelling: string, id: string): string | undefined {
  const cwds = lines.flatMap(({ record }) => (typeof record?.cwd === 'string' ? [record.cwd] : []));
  return cwds.find(cwd => claudeTranscriptPath(cwd, id).split('/')[1] === spelling) ?? cwds[0];
}

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
    return TESTED_CLAUDE_VERSION.test(version.version)
      ? undefined
      : `Claude Code ${version.version} was not tested for moving a conversation (tested: 2.1.2xx and 2.1.3xx), so nothing was written.`;
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
        if (includesSubagent(linesOf(bytes)))
          return refuse('this conversation ran a subagent whose separate transcript cannot be moved with it');
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
    ): Promise<Result<UnpackedConversation, { readonly reason: string }>> {
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
        const sentence = await untested();
        if (sentence !== undefined) return refuse(sentence);

        const plan = {
          from: sourceFolder(lines, spelling, oldId),
          to: folder.replace(/\/+$/u, '') || '/',
          oldId,
          newId,
        };
        const encoder = new TextEncoder();
        const body = joined(
          lines.map(({ bytes, record }) => {
            const copy = JSON.parse(JSON.stringify(record)) as Json;
            return rewriteRecord(copy, plan) ? encoder.encode(`${JSON.stringify(copy)}\n`) : bytes;
          }),
        );

        const home = await ensureHome(core, spec);
        await requirePrivateChain(home);
        await poolHistory(core, spec.ferret);
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
