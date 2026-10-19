/**
 * The daemon calls behind Actions that are more than one call: fork through the latest message, and
 * restart a ferret's CLI with its conversation. Each takes the client it needs as a parameter, so a
 * test hands in a fake and the page hands in the carrier-routed one.
 */

import type { ForkSessionOutcome, IFyApiClient, SessionView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';

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
  let cursor: string | undefined;
  let last: Awaited<ReturnType<ForkClient['messages']>>['messages'][number] | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await client.messages(view.config.id, cursor, PAGE);
    last = read.messages.at(-1) ?? last;
    if (read.nextCursor === null) break;
    cursor = read.nextCursor;
  }
  if (last === undefined) throw new NothingToForkError();
  const outcome = await client.fork(
    view.config.id,
    { through: last.point, selectionBinding: last.selectionBinding, agent: view.config.agent },
    requestId,
  );
  const name = teammate?.trim().toLowerCase();
  if (name !== undefined && name !== '') await client.rename(outcome.session.id, undefined, name);
  return outcome;
};

/**
 * Restarts the ferret's CLI on the login it is already on, with its conversation: the daemon's
 * same-login migration, which snapshots the pane, refuses if in-flight work would be lost, and
 * relaunches with resume. It is how a ferret picks up a newly added MCP server.
 */
export const restartWithResume = async (
  client: Pick<IFyApiClient, 'migrate'>,
  view: SessionView,
  requestId: string,
): Promise<SessionView> => {
  try {
    return await client.migrate(view.config.id, view.config.agent, undefined, false, requestId);
  } catch (reason) {
    if (reason instanceof FyHttpError && reason.code === 'migration_refused' && reason.message.includes(PS_BLIND_SPOT))
      throw new DetailedFailure(RESTART_PS_FAILED, reason.message);
    throw reason;
  }
};
