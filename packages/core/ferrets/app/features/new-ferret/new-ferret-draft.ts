/**
 * THE NEW-FERRET FORM'S DRAFT AND ITS REQUEST. Pure, except `startFerret`, which makes the one call.
 *
 * The typed draft is the source of truth from end to end: the runtime picker (Runtimes' panel in the offered slot) is
 * only a faster way to type the runtime's wrapper into it. `canStartFerret` gates the button and `buildStartBody` is
 * what is sent, so a wrapper the picker never mentioned still starts, and the daemon gets to accept or refuse it.
 *
 * Today's `NewSessionDraft` / `buildStartSessionRequest` (packages/pwa lib/pages/new-session.ts), renamed: the
 * runtime is the `runtime` field and the project folder the `folder` field of `POST /v1/ferrets`, which names both.
 */

import { RuntimeNameSchema, StartOptionsSchema } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';
import type { FerretsClient } from '../../lib/client.ts';

export interface NewFerretDraft {
  /** The runtime's wrapper id: what a ferret is started with. */
  runtime: string;
  folder: string;
  model: string;
  mode: 'auto' | 'interactive';
  /** Launch in the harness's fast mode. */
  fast: boolean;
  /** Start with the Claude Code Remote Control surface published. Off unless the owner opts in. */
  remoteControl: boolean;
  label: string;
  prompt: string;
}

export const emptyNewFerretDraft: NewFerretDraft = {
  runtime: '',
  folder: '',
  model: '',
  mode: 'auto',
  fast: false,
  remoteControl: false,
  label: '',
  prompt: '',
};

export const canStartFerret = (draft: NewFerretDraft, submitting: boolean): boolean => {
  if (submitting || draft.runtime.trim() === '' || draft.folder.trim() === '') return false;
  return draft.mode === 'interactive' || draft.prompt.trim() !== '';
};

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** The body of `POST /v1/ferrets`: who and where, then the start options flat, as the daemon parses them. */
const StartBodySchema = z.strictObject({
  ...StartOptionsSchema.shape,
  runtime: RuntimeNameSchema,
  folder: z.string().min(1).max(4_096),
  prompt: z.string().max(200_000).optional(),
});
export type StartBody = z.infer<typeof StartBodySchema>;

export function buildStartBody(draft: NewFerretDraft): StartBody {
  const folder = optionalText(draft.folder);
  const model = optionalText(draft.model);
  const label = optionalText(draft.label);
  const prompt = optionalText(draft.prompt);
  return StartBodySchema.parse({
    runtime: draft.runtime.trim(),
    // Required by the daemon: a ferret works in a folder. An empty one is refused here with the daemon's own wording.
    folder: folder ?? '',
    ...(model === undefined ? {} : { model }),
    mode: draft.mode,
    ...(draft.fast ? { fast: true } : {}),
    ...(draft.remoteControl ? { remoteControl: true } : {}),
    ...(label === undefined ? {} : { label }),
    ...(prompt === undefined ? {} : { prompt }),
  });
}

const StartedSchema = z.object({ id: z.string().min(1) });

/**
 * ONE ATTEMPT AT A START: the request id and the exact body text it was sent with. A start is idempotent on its request id
 * AND body, so an attempt whose answer was lost must be repeated with the SAME id and body (the daemon then answers the
 * ferret it already started), never with a new id, which would start a second ferret.
 */
export interface StartAttempt {
  readonly requestId: string;
  /** The body as sent: what the recovery read's digest is taken of. */
  readonly payload: string;
}

/**
 * The attempt a submit of `draft` is. A resubmit of the same draft (the body is the same) is the held attempt, id and all;
 * a draft that changed is a genuinely new start and gets a fresh id. `held` is the last attempt that has not succeeded.
 */
export function startAttemptFor(draft: NewFerretDraft, held?: StartAttempt): StartAttempt {
  const payload = JSON.stringify(buildStartBody(draft));
  return held !== undefined && held.payload === payload ? held : { requestId: crypto.randomUUID(), payload };
}

/** Whether a call died without an answer from the daemon (a dropped carrier, a network error, a deadline): the start may still have happened. */
function lostAnswer(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { carrier?: unknown }).carrier === true) return true;
  return error instanceof Error && !('status' in error);
}

const sha256Hex = async (text: string): Promise<string | undefined> => {
  if (globalThis.crypto?.subtle === undefined) return undefined;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Starts the ferret the draft describes and answers its id. A refusal throws with the daemon's sentence.
 *
 * A start is idempotent on its request id (the daemon answers 400 `missing_request_id` to one with none), so the call carries
 * one: the attempt's, or a fresh one. If the answer was lost the start may well have succeeded, so the same POST is sent
 * once more and then the daemon is asked which ferret that request id started (the CLI's recovery, `by-request`); only if
 * that finds nothing is the original failure thrown, and the person's resubmit reuses the same attempt.
 */
export async function startFerret(
  client: FerretsClient,
  draft: NewFerretDraft,
  attempt: StartAttempt | string = crypto.randomUUID(),
): Promise<string> {
  const payload = typeof attempt === 'string' ? JSON.stringify(buildStartBody(draft)) : attempt.payload;
  const requestId = typeof attempt === 'string' ? attempt : attempt.requestId;
  // One body snapshot for both POSTs and the digest: the bytes the daemon hashes are the bytes sent.
  const init = { body: JSON.parse(payload) as unknown, headers: { 'x-fy-request-id': requestId } };
  let original: unknown;
  try {
    return StartedSchema.parse(await client.call('POST /v1/ferrets', init)).id;
  } catch (error) {
    if (!lostAnswer(error)) throw error;
    original = error;
  }
  try {
    return StartedSchema.parse(await client.call('POST /v1/ferrets', init)).id;
  } catch (error) {
    if (!lostAnswer(error)) throw error;
  }
  const digest = await sha256Hex(payload).catch(() => undefined);
  const recovered =
    digest === undefined
      ? undefined
      : await client
          .call('GET /v1/ferrets/by-request/:requestId', { params: { requestId }, query: { payload: digest } })
          .then(answer => StartedSchema.parse(answer).id)
          .catch(() => undefined);
  if (recovered === undefined) throw original;
  return recovered;
}
