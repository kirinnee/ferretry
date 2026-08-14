/**
 * The source half of preparation, over the session documents this daemon already owns.
 *
 * Implements `TransferSourceReader` (seam `SessionTransferPreparePorts.source`) and NOTHING else.
 * It holds one `DaemonStorage` and calls exactly two of its methods — `readConfig` and `readState` —
 * so invariant I1 is a construction property here rather than a convention: there is no write, no
 * lifecycle, no board and no stop on this object to reach for. That is also why it is a distinct
 * adapter instead of a projection hung off the session read service, which can do all of those.
 *
 * Every field is PARSED, never trusted. A configuration document that does not satisfy
 * `SessionConfigSchema` yields `undefined`, which preparation reports as a refusal, because a
 * half-read source produces a plan describing a session that does not exist in the shape it claims.
 * Answering `undefined` is the safe direction: the transfer stops before anything is created.
 *
 * One field deliberately comes from outside the configuration schema: `transcriptProvenance` is read
 * with `storedTranscriptProvenance`, the one helper that owns the `transcript` record's parse.
 * Copying its logic here would be a second parser for one fact.
 *
 * `provenance` — the spawn-side warden stamp — used to be the second such field, parsed off the raw
 * document with an explicit refusal branch beside it. It is now a declared field of
 * `SessionConfigSchema`, so it is simply read: `config.data.provenance`.
 *
 * THE REFUSAL DID NOT GO AWAY, IT MOVED INTO THE SCHEMA, and it is worth being precise about why the
 * branch had to be deleted rather than kept as a belt. A declared optional field that is present and
 * INVALID fails the entire parse — Zod strips unknown keys, never invalid declared ones — so a
 * damaged stamp already makes `config.success` false and `read()` already answers `undefined`. The
 * old branch became unreachable, and an unreachable line is not a harmless one: it fails the
 * hundred-percent integration coverage ledger, and it invites a reader to believe there are two
 * defences here when there is one.
 *
 * The asymmetry it encoded is unchanged and still the safety property. A session with no stamp is a
 * session nothing recorded a warden for, and the lineage facet is right to read that as "no evidence
 * of a warden". A session whose stamp is there and unreadable is the opposite situation: something
 * DID record descent and what it recorded can no longer be read. Answering `undefined` for that case
 * would let the facet write `wardenLineage: false` into the new session — silently deleting the
 * shield a warden descendant exists to keep — so the transfer stops instead, before anything is
 * created.
 *
 * The state document contributes ONE thing: the model the harness was observed running, used only
 * when the session was started without an explicit one. `plan.source.model` describes the source for
 * the report; the target's model is chosen by the caller against the catalogue that owns it, so
 * nothing downstream can mistake this for a target decision. A missing or damaged state document
 * costs that enrichment and nothing else — it must never fail a transfer that the configuration
 * document can describe completely.
 */

import { SessionConfigSchema, SessionStateSchema } from '@ferretry/protocol';
import type { TransferSourceReader, TransferSourceSession } from '../../lib/transfer/types.ts';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';
import { storedTranscriptProvenance } from '../session/transcript/storage-transcript-provenance.ts';

/**
 * An empty string is not a name, a model or a label.
 *
 * The durable plan requires these to be non-empty or null, so a blank carried verbatim would be
 * refused as an invalid payload late, in a message about schemas, rather than read here as the
 * absence it is.
 */
function present(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value;
}

export class StorageTransferSourceReader implements TransferSourceReader {
  constructor(private readonly storage: DaemonStorage) {}

  async read(sessionId: string): Promise<TransferSourceSession | undefined> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return undefined;
    const document = await this.storage.readConfig(id).catch(() => undefined);
    const config = SessionConfigSchema.safeParse(document);
    if (!config.success) return undefined;

    return {
      sessionId: config.data.id,
      incarnation: config.data.incarnation,
      runtimeGeneration: config.data.runtimeGeneration,
      harness: config.data.harness,
      agent: config.data.agent,
      model: present(config.data.model) ?? (await this.observedModel(id)),
      teammate: present(config.data.teammate),
      name: config.data.name,
      label: present(config.data.label),
      cwd: config.data.cwd,
      mode: config.data.mode,
      remoteControl: config.data.remoteControl,
      harnessFlags: config.data.harnessFlags,
      intervalSeconds: config.data.intervalSeconds,
      timeoutSeconds: config.data.timeoutSeconds,
      nudgeAfterSeconds: config.data.nudgeAfterSeconds,
      killAfterSeconds: config.data.killAfterSeconds,
      directSendMaxChars: config.data.directSendMaxChars,
      resumeMenuChoice: config.data.resumeMenuChoice,
      maxSnapshots: config.data.maxSnapshots,
      retry: config.data.retry,
      transcriptProvenance: storedTranscriptProvenance(document) ?? null,
      provenance: config.data.provenance,
    };
  }

  /** What the harness was last seen running, for a session started without an explicit model. */
  private async observedModel(id: SessionId): Promise<string | null> {
    const state = SessionStateSchema.safeParse(await this.storage.readState(id).catch(() => undefined));
    return state.success ? present(state.data.observedModel) : null;
  }
}
