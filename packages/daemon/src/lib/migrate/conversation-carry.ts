import { isAbsolute, join, relative } from 'node:path';
import type { Harness, TranscriptProvenance } from '@ferretry/protocol';
import { claudeTranscriptFile } from '../session/transcript/claude-path.ts';

/**
 * What a Restart or a same-harness migration does with the conversation the session is bound to.
 *
 * THE DEFECT THIS EXISTS FOR. A migration used to re-capture the target's transcript exactly as a
 * start does, and for Claude a capture MINTS a new harness session id. The relaunch then ran
 * `--session-id <new id>`, a file that did not exist yet, so the replacement CLI opened an empty
 * conversation — and Restart CLI, which is a migration onto the same login, wiped the agent's memory
 * every time it was pressed. The previous conversation stayed on disk with nothing pointing at it.
 *
 * A RESTART CONTINUES THE CONVERSATION. The bound harness session id is carried: Claude relaunches
 * with `--resume <same id>`, Codex with `resume <same thread>`. When the login changes the transcript
 * is copied into the target login's harness home first, at the path that harness will look for it,
 * because each login keeps its conversations in its own home and a resume reads only its own.
 *
 * NEVER SILENTLY FRESH. When the conversation cannot be carried — nothing records it, Codex never
 * proved which rollout is this session's, the target declares no home — the answer is a refusal with
 * the reason in plain words. Starting a new conversation is the person's explicit choice
 * (`conversation: 'fresh'`), never a fallback.
 *
 * Pure: the caller reads the disk, copies the file and writes the record.
 */

/** What a migration knows about the conversation before it decides. */
export interface ConversationCarryRequest {
  /** The harness family, which a migration has already proved is the same on both sides. */
  readonly harness: Harness;
  /** The transcript the session is bound to now, as its configuration records it. */
  readonly source: TranscriptProvenance | undefined;
  /** Whether the harness has written `source.file`, i.e. whether a conversation exists to resume. */
  readonly sourceWritten: boolean;
  /** The harness home the target login's wrapper exports, or nothing when it declares none. */
  readonly targetHome: string | undefined;
  /** The account being moved onto, so a refusal can name it. */
  readonly targetAgent: string;
  /** The session's working directory, which Claude's transcript path is derived from. */
  readonly cwd: string;
}

/** The record the relaunch is bound to, and the copy that has to happen first for it to be true. */
export interface ConversationCarried {
  readonly kind: 'carry';
  readonly provenance: TranscriptProvenance;
  /** Absent when the target already holds the file — the same login, or nothing written yet. */
  readonly copy?: { readonly from: string; readonly to: string };
}

/** Why the conversation cannot go with the session, in words a person reads. */
export interface ConversationUnresumable {
  readonly kind: 'unresumable';
  readonly reason: string;
}

export type ConversationCarry = ConversationCarried | ConversationUnresumable;

/** The sentence every refusal ends with, naming the two ways past it. */
const WAYS_PAST = 'Nothing was restarted. Choose "Start fresh" to restart with a new conversation instead.';

const unresumable = (reason: string): ConversationUnresumable => ({
  kind: 'unresumable',
  reason: `${reason} ${WAYS_PAST}`,
});

/**
 * Whether the bound conversation can be carried onto the target, and how.
 *
 * Claude's file is DERIVED in the target home from the id and the working directory, the same rule a
 * start names it by, so the resumed harness finds it where it looks. Codex's is kept at the same path
 * relative to its home, because `resume <thread>` searches the date-partitioned `sessions/` tree.
 */
export function planConversationCarry(request: ConversationCarryRequest): ConversationCarry {
  const { source, targetHome } = request;
  if (source === undefined)
    return unresumable('This session has no recorded conversation, so there is nothing Ferretry can resume.');
  if (source.identity === 'undiscovered' || source.harnessSessionId === undefined || source.file === undefined)
    return unresumable(
      "Ferretry hasn't matched this session to its conversation yet, so it can't tell which one to resume.",
    );
  if (targetHome === undefined)
    return unresumable(
      `${request.targetAgent} doesn't say where it keeps its conversations, so this one can't be moved there.`,
    );
  const id = source.harnessSessionId;
  const target =
    request.harness === 'claude' ? claudeTranscriptFile(targetHome, request.cwd, id) : codexTarget(source, targetHome);
  if (target === undefined)
    return unresumable(
      `The conversation file ${source.file} isn't inside its login's home, so it can't be moved to ${request.targetAgent}.`,
    );
  // A Claude session whose harness never wrote anything has no conversation to lose: relaunching with
  // the same id creates it, exactly as the start would have. A Codex thread is named by the harness,
  // so one that is gone cannot be recreated under the same name.
  if (!request.sourceWritten && request.harness === 'codex')
    return unresumable(`The conversation file ${source.file} is gone, so there is nothing to resume.`);
  const provenance: TranscriptProvenance = { ...source, home: targetHome, file: target };
  return request.sourceWritten && target !== source.file
    ? { kind: 'carry', provenance, copy: { from: source.file, to: target } }
    : { kind: 'carry', provenance };
}

/** The rollout's place under the target home, or nothing when it is not under its own home. */
function codexTarget(source: TranscriptProvenance, targetHome: string): string | undefined {
  if (source.file === undefined) return undefined;
  const inside = relative(source.home, source.file);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined;
  return join(targetHome, inside);
}

/** One transcript in a harness home that might be this session's earlier conversation. */
export interface PriorConversation {
  /** The harness's own session id for it. */
  readonly id: string;
  readonly file: string;
  /** Last write, epoch milliseconds. */
  readonly modifiedMs: number;
  /** Whether its bytes name this session's own directory, which every turn Ferretry hands it does. */
  readonly mentionsSession: boolean;
}

/** What the repair knows about the session it is rebinding. */
export interface PreviousConversationRequest {
  readonly harness: Harness;
  /** The transcript the session is bound to now — the one a broken Restart started. */
  readonly current: TranscriptProvenance | undefined;
  /** The home the candidates were listed from. */
  readonly home: string;
  readonly candidates: readonly PriorConversation[];
  readonly at: string;
}

/**
 * The repair for a session an earlier Restart moved onto a new conversation: the newest OTHER
 * transcript in its home that names the session's directory.
 *
 * The directory is the proof, for the reason a Codex rollout is correlated by it: every turn the
 * daemon hands an agent is a file under that directory, so a conversation that names it was had by
 * this session. The current conversation is excluded — it is the one being repaired away from.
 */
export function previousConversation(request: PreviousConversationRequest): ConversationCarry {
  const currentId = request.current?.harnessSessionId;
  const found = request.candidates
    .filter(candidate => candidate.mentionsSession && candidate.id !== currentId)
    .toSorted((left, right) => right.modifiedMs - left.modifiedMs)[0];
  if (found === undefined)
    return unresumable("Ferretry couldn't find an earlier conversation for this session to go back to.");
  const provenance: TranscriptProvenance =
    request.harness === 'claude'
      ? {
          v: 1,
          home: request.home,
          harnessSessionId: found.id,
          identity: 'minted',
          file: found.file,
          resolvedAt: request.at,
        }
      : {
          v: 1,
          home: request.home,
          harnessSessionId: found.id,
          identity: 'adopted',
          file: found.file,
          resolvedAt: request.at,
          ...(request.current?.baseline === undefined ? {} : { baseline: request.current.baseline }),
          ...(request.current?.correlationToken === undefined
            ? {}
            : { correlationToken: request.current.correlationToken }),
        };
  return { kind: 'carry', provenance };
}

/** The disk a carry reads and writes, behind a port so the decision above stays pure. */
export interface ConversationFilesPort {
  /** Whether the harness has written this transcript. */
  written(file: string): Promise<boolean>;
  /** Copies a transcript into another login's home, creating its folders and replacing a stale copy. */
  copy(from: string, to: string): Promise<void>;
  /** The transcripts a harness home holds for this working directory, and whether each names `needle`. */
  prior(harness: Harness, home: string, cwd: string, needle: string): Promise<readonly PriorConversation[]>;
}
