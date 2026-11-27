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

/** How many of the newest messages the picker reads first. */
const FORK_PICKER_MESSAGES = 200;

/** How many messages each read back to an older row takes (the most a page serves). */
const FORK_BACK_MESSAGES = 1000;

/** What a person is told when the row they clicked is not a message a fork can be cut at. */
const NOT_FOUND =
  "That message could not be found among the conversation's messages, so it cannot be forked from. Fork from another message instead.";

/** One message a person may fork at: what they said, and the proof the daemon issued for it. */
export interface ForkChoice {
  readonly point: string;
  /** The byte of the transcript the message begins at: the identity the chat's own row carries (`TranscriptEntry.offset`). */
  readonly offset?: number;
  readonly selectionBinding: string;
  readonly text: string;
  readonly timestamp?: string;
}

export interface ForkChoices {
  /** What the person said, oldest first; a fork keeps through the end of the one they pick, answer included. */
  readonly choices: readonly ForkChoice[];
  /** The conversation has older messages than the picker read. */
  readonly older: boolean;
  /** The point of the message the person clicked, when they clicked one; absent, the form opens on the latest. */
  readonly initial?: string;
}

/** The byte a point begins at: a point is spelled `<byteOffset>.<blockIndex>` and the byte is the chat row's own identity. */
const offsetOf = (point: string): number | undefined => {
  const match = /^(\d+)\.\d+$/u.exec(point);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const choiceOf = (message: TranscriptMessage): ForkChoice => ({
  point: message.point,
  ...(offsetOf(message.point) === undefined ? {} : { offset: offsetOf(message.point) as number }),
  selectionBinding: message.selectionBinding,
  text: message.text,
  ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
});

const readPage = async (client: Pick<PluginClient, 'call'>, ferretId: string, query: Record<string, string>) =>
  TranscriptPageSchema.parse(await client.call('GET /v1/ferrets/:ferretId/messages', { params: { ferretId }, query }));

const said = (message: TranscriptMessage): boolean => message.role === 'user' && message.text.trim() !== '';

/**
 * The newest messages of the ferret's conversation, narrowed to what the person said. With `at` (the byte offsets of the row
 * the person clicked) it reads back, page by page, until that row is among them, and opens on it; a row that is not a
 * message of the conversation throws a sentence saying so, rather than forking some other row.
 */
export const readForkChoices = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
  at?: readonly number[],
): Promise<ForkChoices> => {
  const first = await readPage(client, ferretId, { tail: '1', limit: String(FORK_PICKER_MESSAGES) });
  let messages: readonly TranscriptMessage[] = first.messages;
  let back = first.previousCursor ?? null;
  const clicked = (rows: readonly TranscriptMessage[]) =>
    at === undefined ? undefined : rows.find(row => said(row) && at.some(offset => offset === offsetOf(row.point)));
  while (at !== undefined && clicked(messages) === undefined && back !== null) {
    const older = await readPage(client, ferretId, { through: back, limit: String(FORK_BACK_MESSAGES) });
    messages = [...older.messages, ...messages];
    back = older.previousCursor ?? null;
  }
  const initial = clicked(messages);
  if (at !== undefined && initial === undefined) throw new Error(NOT_FOUND);
  return {
    choices: messages.filter(said).map(choiceOf),
    older: back !== null,
    ...(initial === undefined ? {} : { initial: initial.point }),
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
