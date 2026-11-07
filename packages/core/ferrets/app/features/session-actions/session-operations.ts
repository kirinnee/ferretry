/**
 * The daemon calls behind Actions that are more than one call: fork through the latest message, and
 * restart a ferret's CLI with its conversation. Each takes the client it needs as a parameter, so a
 * test hands in a fake and the page hands in the carrier-routed one.
 */

import { type ForkSessionOutcome, type ContextDowngrade, type MoveConversation, MoveRefusedBodySchema, type MoveRefusal, type SessionView } from '../../../contract/index.ts';
import { type IFyApiClient } from '@ferretry/app';
import { FyHttpError } from '@ferretry/app';
import { staleMessageEvidence, withFreshMessageCursor } from '../../../../../plugins/conversation/app/lib/message-cursor.ts';
import { downgradeOf, downgradeSentence } from './context-downgrade.ts';

/** The largest page the messages route serves. */
const PAGE = 1_000;
/** A conversation longer than this many pages is not walked from the browser. */
const MAX_PAGES = 50;

export class NothingToForkError extends Error {
  constructor() {
    super('there is no message to fork from yet — send this ferret something first');
  }
}

/** A failure with a plain sentence for the alert and the daemon's own words kept behind a disclosure. */
export class DetailedFailure extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/** The daemon's blind-spot prefix when the process table could not be read (bun-process-inventory.ts). */
const PS_BLIND_SPOT = 'the process table could not be read';
const RESTART_PS_FAILED = "Couldn't check the agent's processes on this machine (ps failed). Nothing was restarted.";

type ForkClient = Pick<IFyApiClient, 'messages' | 'fork' | 'rename'>;

const latestMessage = async (client: ForkClient, sessionId: string) =>
  withFreshMessageCursor(async () => {
    let cursor: string | undefined;
    let last: Awaited<ReturnType<ForkClient['messages']>>['messages'][number] | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const read = await client.messages(sessionId, cursor, PAGE);
      last = read.messages.at(-1) ?? last;
      if (read.nextCursor === null) break;
      cursor = read.nextCursor;
    }
    return last;
  });

/**
 * Forks a ferret through its LATEST durable message, on its own login, and names the fork when a name
 * was given. The messages route reads forward, so the last row is found by walking to the end; the
 * row's point and its binding are echoed exactly as served.
 */
export const forkThroughLatest = async (
  client: ForkClient,
  view: SessionView,
  teammate: string | undefined,
  requestId: string,
): Promise<ForkSessionOutcome> => {
  const last = await latestMessage(client, view.config.id);
  if (last === undefined) throw new NothingToForkError();
  const outcome = await client
    .fork(
      view.config.id,
      { through: last.point, selectionBinding: last.selectionBinding, agent: view.config.agent },
      requestId,
    )
    .catch(async (reason: unknown) => {
      if (!staleMessageEvidence(reason, 'selection_stale')) throw reason;
      // Refresh the evidence, but let the person choose again before another fork request is sent.
      await latestMessage(client, view.config.id).catch(() => undefined);
      throw new Error('The conversation changed — choose the message again.');
    });
  const name = teammate?.trim().toLowerCase();
  if (name !== undefined && name !== '') await client.rename(outcome.session.id, undefined, name);
  return outcome;
};

/**
 * The daemon refused a Restart because something the agent is running could not be shown to be safe
 * to stop. Nothing was restarted. It carries what the daemon saw, in the daemon's plain words, and
 * {@link RestartRefused.restartAnyway}: the one way past, which the person must choose.
 */
export class RestartRefused extends Error {
  constructor(
    readonly refusal: MoveRefusal,
    readonly restartAnyway: () => Promise<SessionView>,
  ) {
    super(restartRefusedSentence(refusal));
  }
}

const REFUSED_CAUSE: Readonly<Record<MoveRefusal['blockedBy'], string>> = {
  unknown: 'Ferretry can’t tell if what the agent is running is safe to stop',
  destructive: 'the agent is running something that could be left half-done if it is stopped',
  unreadable: 'Ferretry couldn’t check what the agent is running',
};

/** Why the daemon would not stop what the agent is running, as a clause. */
export const refusedCause = (refusal: MoveRefusal): string => REFUSED_CAUSE[refusal.blockedBy];

/** One sentence for an alert: why nothing happened, and that nothing did. */
export const restartRefusedSentence = (refusal: MoveRefusal): string =>
  `Restart paused — ${REFUSED_CAUSE[refusal.blockedBy]}. Nothing was restarted.`;

/**
 * The refusal the daemon attached, when it attached one that names something to look at. An older
 * daemon sends the sentence alone; that case keeps its own handling.
 */
const refusalOf = (reason: FyHttpError): MoveRefusal | null => {
  const body = MoveRefusedBodySchema.safeParse(reason.body);
  const refusal = body.success ? body.data.inflight : undefined;
  return refusal?.items.some(item => item.blocks) === true ? refusal : null;
};

/**
 * The daemon refused a Restart because it would give the conversation a smaller context window than it
 * is running in. Nothing was restarted. `downgrade` is null when an older daemon said it without the
 * numbers; {@link RestartDowngradeRefused.restartAnyway} is the one way past, which the person chooses.
 */
export class RestartDowngradeRefused extends Error {
  constructor(
    readonly downgrade: ContextDowngrade | null,
    readonly restartAnyway: () => Promise<SessionView>,
  ) {
    super(`Restart paused — ${downgradeSentence(downgrade)} Nothing was restarted.`);
  }
}

/**
 * The daemon refused a Restart because the conversation could not go with it — it never silently
 * opens a new one. Nothing was restarted. `reason` is the daemon's plain sentence;
 * {@link RestartUnresumable.restartAnyway} starts FRESH, which only the person may choose.
 */
export class RestartUnresumable extends Error {
  constructor(
    readonly reason: string,
    readonly restartAnyway: () => Promise<SessionView>,
  ) {
    super(reason);
  }
}

/** What a Restart the daemon paused was paused for. */
export type PausedRestart = RestartRefused | RestartDowngradeRefused | RestartUnresumable;

/** Which refusals the person has already confirmed, so a chain of two never asks the first again. */
interface RestartConsent {
  readonly forceInflight?: boolean;
  readonly allowContextDowngrade?: boolean;
  /** Absent, the daemon resumes the conversation or refuses; see `MoveConversation`. */
  readonly conversation?: MoveConversation;
}

/**
 * Restarts the ferret's CLI on the login it is already on, with its conversation: the daemon's
 * same-login move, which snapshots the pane, refuses if in-flight work would be lost, and
 * relaunches with resume. It is how a ferret picks up a newly added MCP server.
 *
 * A refusal that names what is running is thrown as {@link RestartRefused}, and one about a smaller
 * context window as {@link RestartDowngradeRefused}. Each carries `restartAnyway`, which asks again with
 * that consent ADDED to whatever was already confirmed, under a FRESH request id: the daemon remembers
 * an id with the body it first saw, and the same id with a different body is a 409 `request_id_reused`.
 */
export const restartWithResume = async (
  client: Pick<IFyApiClient, 'move'>,
  view: SessionView,
  requestId: string,
  consent: RestartConsent = {},
): Promise<SessionView> => {
  const again = async (more: RestartConsent): Promise<SessionView> =>
    await restartWithResume(client, view, `${requestId}-anyway-${Date.now()}`, { ...consent, ...more });
  try {
    return await client.move(
      view.config.id,
      view.config.agent,
      undefined,
      consent.allowContextDowngrade === true,
      requestId,
      consent.forceInflight,
      ...(consent.conversation === undefined ? [] : [consent.conversation]),
    );
  } catch (reason) {
    if (!(reason instanceof FyHttpError)) throw reason;
    if (reason.code === 'conversation_unresumable')
      throw new RestartUnresumable(reason.message, async () => await again({ conversation: 'fresh' }));
    if (reason.code === 'context_downgrade_refused')
      throw new RestartDowngradeRefused(downgradeOf(reason), async () => await again({ allowContextDowngrade: true }));
    if (reason.code !== 'move_refused') throw reason;
    const refusal = refusalOf(reason);
    if (refusal !== null) throw new RestartRefused(refusal, async () => await again({ forceInflight: true }));
    if (reason.message.includes(PS_BLIND_SPOT)) throw new DetailedFailure(RESTART_PS_FAILED, reason.message);
    throw reason;
  }
};

/**
 * The repair for a ferret an earlier Restart moved onto a new, empty conversation: restart it on the
 * conversation it had before — the newest other one on its login that names this ferret. Refusals are
 * the Restart's own, so the same panel answers them.
 */
export const restartOnEarlierConversation = async (
  client: Pick<IFyApiClient, 'move'>,
  view: SessionView,
  requestId: string,
): Promise<SessionView> => await restartWithResume(client, view, requestId, { conversation: 'previous' });
