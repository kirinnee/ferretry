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

/** Starts the ferret the draft describes and answers its id. A refusal throws with the daemon's sentence. */
export async function startFerret(client: FerretsClient, draft: NewFerretDraft): Promise<string> {
  const answer = await client.call('POST /v1/ferrets', { body: buildStartBody(draft) });
  return StartedSchema.parse(answer).id;
}
