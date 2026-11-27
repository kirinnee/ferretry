/**
 * The browser's half of "Fork into a new ferret…": which messages a fork can be cut at (the rows a transcript page serves,
 * each with the binding the daemon issued for exactly that message) and the fork itself, through the half's own client, so a
 * daemon only the relay reaches is reached and nothing here carries a credential.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type ForkRequest,
  type ForkResult,
  ForkResultSchema,
  type TranscriptMessage,
  TranscriptPageSchema,
} from '../../contract/index.ts';

/** How many of the newest messages the picker reads: a fork of an older turn is made from a longer read of the page. */
const FORK_PICKER_MESSAGES = 200;

/** One message a person may fork at: what they said, and the proof the daemon issued for it. */
export interface ForkChoice {
  readonly point: string;
  readonly selectionBinding: string;
  readonly text: string;
  readonly timestamp?: string;
}

export interface ForkChoices {
  /** What the person said, oldest first; a fork keeps through the end of the one they pick, answer included. */
  readonly choices: readonly ForkChoice[];
  /** The conversation has older messages than the picker read. */
  readonly older: boolean;
}

const choiceOf = (message: TranscriptMessage): ForkChoice => ({
  point: message.point,
  selectionBinding: message.selectionBinding,
  text: message.text,
  ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
});

/** The newest messages of the ferret's conversation, narrowed to what the person said. */
export const readForkChoices = async (client: Pick<PluginClient, 'call'>, ferretId: string): Promise<ForkChoices> => {
  const page = TranscriptPageSchema.parse(
    await client.call('GET /v1/ferrets/:ferretId/messages', {
      params: { ferretId },
      query: { tail: '1', limit: String(FORK_PICKER_MESSAGES) },
    }),
  );
  return {
    choices: page.messages.filter(message => message.role === 'user' && message.text.trim() !== '').map(choiceOf),
    older: page.previousCursor !== null && page.previousCursor !== undefined,
  };
};

/** Forks the ferret. A refusal throws with the daemon's own sentence. */
export const postFork = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
  body: ForkRequest,
): Promise<ForkResult> =>
  ForkResultSchema.parse(
    await client.call('POST /v1/ferrets/:ferretId/fork', {
      params: { ferretId },
      body,
      headers: { 'x-fy-request-id': crypto.randomUUID() },
    }),
  );
