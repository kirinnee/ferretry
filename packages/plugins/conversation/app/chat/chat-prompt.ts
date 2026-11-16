/**
 * WHAT THE OBSERVER RECORDED ABOUT THE TURN, read for the chat. One GET of Ferrets' redacted prompt route
 * (`GET /v1/ferrets/:ferretId/prompt`): the turn state the whose-turn observer STORED (`needs-input` kept distinct from
 * `your-turn`), the instant it stored it, and the words / permission request / harness dialog behind a `needs-input`.
 *
 * The summary's `stateAt` is NOT this: the registry stamps it from its own clock after the observer has written, and it
 * folds `needs-input` into `idle`. So a field here is the observer's or it is absent; nothing is dated from a browser
 * clock, and a read that fails or says something this build cannot read is `undefined` ("not live": nothing is acted on).
 */

import { FerretViewSchema } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';

const stored = FerretViewSchema.shape.state.shape;

/** The answer as served; each part is narrowed on its own, so one that does not fit drops only itself. */
const PromptAnswerSchema = z.looseObject({
  turnState: z.unknown().optional(),
  turnStateAt: z.unknown().optional(),
  prompt: z.unknown().optional(),
  permissionRequest: z.unknown().optional(),
  dialog: z.unknown().optional(),
});

/** The observer's facts about the turn, in the names the chat's state uses. */
export interface ChatPrompt {
  readonly turnState?: z.infer<typeof stored.turnState> | undefined;
  readonly turnStateAt?: string | undefined;
  readonly turnPrompt?: string | undefined;
  readonly permissionRequest?: z.infer<typeof stored.permissionRequest> | undefined;
  readonly harnessDialog?: z.infer<typeof stored.harnessDialog> | undefined;
}

/** Narrows one part: its value when it fits, else absent. */
const narrow = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/** The prompt answer, narrowed. `undefined` when it is not an object this build can read. */
export const chatPromptOf = (raw: unknown): ChatPrompt | undefined => {
  const answer = PromptAnswerSchema.safeParse(raw);
  if (!answer.success) return undefined;
  const turnState = narrow(stored.turnState.unwrap(), answer.data.turnState);
  const turnStateAt = narrow(stored.turnStateAt.unwrap(), answer.data.turnStateAt);
  const turnPrompt = narrow(stored.turnPrompt.unwrap(), answer.data.prompt);
  const permissionRequest = narrow(stored.permissionRequest.unwrap(), answer.data.permissionRequest);
  const harnessDialog = narrow(stored.harnessDialog.unwrap(), answer.data.dialog);
  return {
    ...(turnState === undefined ? {} : { turnState }),
    // A date without the state it dates is not a turn's date.
    ...(turnState === undefined || turnStateAt === undefined ? {} : { turnStateAt }),
    ...(turnPrompt === undefined ? {} : { turnPrompt }),
    ...(permissionRequest === undefined ? {} : { permissionRequest }),
    ...(harnessDialog === undefined ? {} : { harnessDialog }),
  };
};

/** Reads the prompt. A refusal, a missing route or an unreadable answer is `undefined`: the chat claims no turn from it. */
export const readChatPrompt = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
): Promise<ChatPrompt | undefined> => {
  try {
    return chatPromptOf(await client.call('GET /v1/ferrets/:ferretId/prompt', { params: { ferretId }, quiet: true }));
  } catch {
    return undefined;
  }
};
