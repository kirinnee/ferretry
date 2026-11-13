/**
 * The daemon calls behind Actions. Each takes the client it needs as a parameter, so a test hands in a scripted one and
 * the panel hands in the half's own. Every call is a route key; nothing here holds an address, a token or a fetch.
 *
 * WHO MAY DO WHAT IS NOT DECIDED HERE. Stop, rename, resume and move are the owner's acts, or a governed device's, and
 * the daemon (Gate) answers 403 or a step-up for the rest; this file only carries the refusal to the screen in words.
 */

import {
  type ContextDowngrade,
  type FerretSummary,
  FerretSummarySchema,
  type MoveConversation,
  type MoveRefusal,
  MoveRefusalSchema,
  type MoveSessionRequestInput,
} from '../../../contract/index.ts';
import { callFailure, type FerretsClient } from '../../lib/client.ts';
import { downgradeOf, downgradeSentence, type RefusedCall } from '../../lib/context-downgrade.ts';
import type { RenamePatch } from './rename-model.ts';

const REQUEST_ID_HEADER = 'x-fy-request-id';

/** A failure with a plain sentence for the alert and the daemon's own words kept behind a disclosure. */
export class DetailedFailure extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/** The daemon's blind-spot prefix when the process table could not be read. */
const PS_BLIND_SPOT = 'the process table could not be read';
const RESTART_PS_FAILED = "Couldn't check the agent's processes on this machine (ps failed). Nothing was restarted.";

const params = (ferret: string): { readonly ferretId: string } => ({ ferretId: ferret });

// ─── the lifecycle acts ─────────────────────────────────────────────────────────────────────────────────────────────

export const stopFerret = async (client: FerretsClient, ferret: string): Promise<void> => {
  await client.call('POST /v1/ferrets/:ferretId/stop', { params: params(ferret), body: {} });
};

export const resumeFerret = async (client: FerretsClient, ferret: string): Promise<void> => {
  await client.call('POST /v1/ferrets/:ferretId/resume', { params: params(ferret), body: {} });
};

/** Pins or unpins the ferret to the top of the sidebar: a person's act (the route refuses an agent). */
export const setFerretPinned = async (client: FerretsClient, ferret: string, pinned: boolean): Promise<void> => {
  await client.call(pinned ? 'POST /v1/ferrets/:ferretId/pin' : 'POST /v1/ferrets/:ferretId/unpin', {
    params: params(ferret),
  });
};

/** Renames a ferret: its callsign (`name`), its task title, or both. The daemon refuses a callsign already taken. */
export const renameFerret = async (client: FerretsClient, ferret: string, patch: RenamePatch): Promise<FerretSummary> =>
  FerretSummarySchema.parse(
    await client.call<unknown>('POST /v1/ferrets/:ferretId/rename', { params: params(ferret), body: patch }),
  );

// ─── Restart: a move onto the login the ferret is already on ───────────────────────────────────────────────────────

/** What a refused call carries when the shell's client keeps the body: read structurally, never by class. */
const refusedCall = (reason: unknown): RefusedCall => ({
  message: reason instanceof Error ? reason.message : String(reason),
  body: (reason as { readonly body?: unknown } | null)?.body,
});

/**
 * The daemon refused a Restart because something the agent is running could not be shown to be safe to stop. Nothing
 * was restarted. It carries what the daemon saw, in the daemon's plain words, and {@link RestartRefused.restartAnyway}: the one way past, which
 * the person must choose.
 */
export class RestartRefused extends Error {
  constructor(
    readonly refusal: MoveRefusal,
    readonly restartAnyway: () => Promise<FerretSummary>,
  ) {
    super(restartRefusedSentence(refusal));
  }
}

const REFUSED_CAUSE: Readonly<Record<MoveRefusal['blockedBy'], string>> = {
  unknown: 'Ferretry can’t tell if what the agent is running is safe to stop',
  destructive: 'the agent is running something that could be left half-done if it is stopped',
  unreadable: 'Ferretry couldn’t check what the agent is running',
};

/** One sentence for an alert: why nothing happened, and that nothing did. */
export const restartRefusedSentence = (refusal: MoveRefusal): string =>
  `Restart paused — ${REFUSED_CAUSE[refusal.blockedBy]}. Nothing was restarted.`;

/** The refusal the daemon attached, when it attached one that names something to look at. */
const refusalOf = (reason: unknown): MoveRefusal | null => {
  const body = (reason as { readonly body?: { readonly inflight?: unknown } } | null)?.body;
  const parsed = MoveRefusalSchema.safeParse(body?.inflight);
  return parsed.success && parsed.data.items.some(item => item.blocks) ? parsed.data : null;
};

/**
 * The daemon refused a Restart because it would give the conversation a smaller context window than it is running in.
 * Nothing was restarted. `downgrade` is null when the numbers did not come with it.
 */
export class RestartDowngradeRefused extends Error {
  constructor(
    readonly downgrade: ContextDowngrade | null,
    readonly restartAnyway: () => Promise<FerretSummary>,
  ) {
    super(`Restart paused — ${downgradeSentence(downgrade)} Nothing was restarted.`);
  }
}

/**
 * The daemon refused a Restart because the conversation could not go with it — it never silently opens a new one.
 * Nothing was restarted. `reason` is the daemon's plain sentence; {@link RestartUnresumable.restartAnyway} starts
 * FRESH, which only the person may choose.
 */
export class RestartUnresumable extends Error {
  constructor(
    readonly reason: string,
    readonly restartAnyway: () => Promise<FerretSummary>,
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
  /** Absent, the daemon resumes the conversation or refuses. */
  readonly conversation?: MoveConversation;
}

/** A fresh request id for one Restart press: the daemon remembers an id with the body it first saw. */
export const newRestartRequestId = (): string => `ferret-restart-${globalThis.crypto.randomUUID()}`;

/** The runtime a restart relaunches on: the one the ferret already has. */
const restartTarget = (ferret: Pick<FerretSummary, 'runtime'>): string | undefined => ferret.runtime;

/**
 * Restarts the ferret's CLI on the login it is already on, with its conversation: the move onto the same runtime, which
 * snapshots the pane, refuses if in-flight work would be lost, and relaunches with resume. It is how a ferret picks up
 * a newly added MCP server.
 *
 * A refusal that names what is running is thrown as {@link RestartRefused}, one about a smaller context window as
 * {@link RestartDowngradeRefused}, and one about the conversation as {@link RestartUnresumable}. Each carries
 * `restartAnyway`, which asks again with that consent ADDED to whatever was already confirmed, under a FRESH request
 * id: the daemon remembers an id with the body it first saw, and the same id with a different body is a 409
 * `request_id_reused`.
 */
export const restartWithResume = async (
  client: FerretsClient,
  ferret: Pick<FerretSummary, 'id' | 'runtime'>,
  requestId: string,
  consent: RestartConsent = {},
): Promise<FerretSummary> => {
  const agent = restartTarget(ferret);
  if (agent === undefined)
    throw new Error('This ferret has no runtime recorded, so there is nothing to restart it on.');
  const again = async (more: RestartConsent): Promise<FerretSummary> =>
    await restartWithResume(client, ferret, `${requestId}-anyway-${globalThis.Date.now()}`, { ...consent, ...more });
  const body: MoveSessionRequestInput = {
    agent,
    allowContextDowngrade: consent.allowContextDowngrade === true,
    forceInflight: consent.forceInflight === true,
    ...(consent.conversation === undefined ? {} : { conversation: consent.conversation }),
  };
  try {
    return FerretSummarySchema.parse(
      await client.call<unknown>('POST /v1/ferrets/:ferretId/move', {
        params: params(ferret.id),
        body,
        headers: { [REQUEST_ID_HEADER]: requestId },
      }),
    );
  } catch (reason) {
    const failure = callFailure(reason);
    if (failure?.code === 'conversation_unresumable')
      throw new RestartUnresumable(refusedCall(reason).message, async () => await again({ conversation: 'fresh' }));
    if (failure?.code === 'context_downgrade_refused')
      throw new RestartDowngradeRefused(
        downgradeOf(refusedCall(reason)),
        async () => await again({ allowContextDowngrade: true }),
      );
    if (failure?.code !== 'move_refused') throw reason;
    const refusal = refusalOf(reason);
    if (refusal !== null) throw new RestartRefused(refusal, async () => await again({ forceInflight: true }));
    const { message } = refusedCall(reason);
    if (message.includes(PS_BLIND_SPOT)) throw new DetailedFailure(RESTART_PS_FAILED, message);
    throw reason;
  }
};

/**
 * The repair for a ferret an earlier Restart moved onto a new, empty conversation: restart it on the conversation it
 * had before. Refusals are the Restart's own, so the same panel answers them.
 */
export const restartOnEarlierConversation = async (
  client: FerretsClient,
  ferret: Pick<FerretSummary, 'id' | 'runtime'>,
  requestId: string,
): Promise<FerretSummary> => await restartWithResume(client, ferret, requestId, { conversation: 'previous' });
