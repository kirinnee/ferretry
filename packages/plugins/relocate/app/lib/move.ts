/**
 * THE MOVE, AS THE APP DRIVES IT (C-45): the app holds a session on both machines and carries ciphertext between them. No
 * machine talks to another, nothing is paired and no secret or key is read here: the one-time key is the target's, and what
 * crosses is ciphertext this half cannot open. Each step names the machine it runs on, so a device that wants a passkey asks
 * for it on THAT machine (`press`, the shell's own step-up and unlock), once per machine for the whole move.
 *
 * Pure of React: the dialog draws it, and the two-daemon acceptance drives the same functions against two real daemons.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { toBase64Url } from '@ferretry/std/sealing';
import {
  ExportResponseSchema,
  ImportResponseSchema,
  type ImportResponse,
  type MoveRow,
  type PreflightResponse,
  PreflightResponseSchema,
  type RelocateOffer,
  RelocateOfferSchema,
  type TargetPreflightResponse,
  TargetPreflightResponseSchema,
} from '../../contract/index.ts';

/** One machine the app holds a session on: its id, its name, the plugin's own client there and the shell's `press`. */
export interface Machine {
  readonly daemon: string;
  readonly name: string;
  readonly client: Pick<PluginClient, 'call'>;
  /** Runs an act on this machine behind its unlock and passkey step-up; `undefined` when the person dismissed the prompt. */
  readonly press: <T>(act: () => Promise<T>) => Promise<T | undefined>;
}

/** A move that stopped, in words a person can act on. Never carries a body, a key or a token. */
export class MoveStopped extends Error {
  constructor(
    message: string,
    /** The machine whose answer stopped it, when one did. */
    readonly at?: string,
  ) {
    super(message);
    this.name = 'MoveStopped';
  }
}

const sentenceOf = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : 'the machine did not say why';

/** One act on one machine: behind its step-up, with a refusal named by machine. */
async function on<T>(machine: Machine, act: () => Promise<T>): Promise<T> {
  let answer: T | undefined;
  try {
    answer = await machine.press(act);
  } catch (error) {
    throw new MoveStopped(`${machine.name}: ${sentenceOf(error)}`, machine.daemon);
  }
  if (answer === undefined)
    throw new MoveStopped(`The move stopped: ${machine.name} was not unlocked with your passkey.`, machine.daemon);
  return answer;
}

/** A person releases A's held export explicitly; the daemon confirms A is stopped or fenced before freeing its slot. */
export async function releaseMove(ferret: string, from: Machine): Promise<void> {
  await on(from, () => from.client.call('POST /v1/relocate/exports/release', { body: { ferretId: ferret } }));
}

/** What the person reads before agreeing: both machines' preflights, with the offer that makes the target's answer good. */
export interface Review {
  readonly offer: RelocateOffer;
  readonly source: PreflightResponse;
  readonly target: TargetPreflightResponse;
  /** Whether a move could start now: both machines said yes. */
  readonly ok: boolean;
  /** Every refusal, each saying which machine said it. */
  readonly refusals: readonly string[];
}

/** Opens the target's one-time offer, then asks the source what would move and the target what it can take. */
export async function review(
  ferret: string,
  from: Machine,
  to: Machine,
  options: { readonly cloneInto?: string } = {},
): Promise<Review> {
  const offer = RelocateOfferSchema.parse(await on(to, () => to.client.call('POST /v1/relocate/offers')));
  if (offer.daemonId !== to.daemon)
    throw new MoveStopped(`${to.name} answered with another machine’s offer, so nothing was sent.`, to.daemon);
  const source = PreflightResponseSchema.parse(
    await on(from, () =>
      from.client.call('POST /v1/relocate/:ferretId/preflight', {
        params: { ferretId: ferret },
        body: { to: to.daemon },
      }),
    ),
  );
  const target = TargetPreflightResponseSchema.parse(
    await on(to, () =>
      to.client.call('POST /v1/relocate/offers/:offerId/preflight', {
        params: { offerId: offer.offerId },
        body: { needs: source.needs, ...(options.cloneInto === undefined ? {} : { cloneInto: options.cloneInto }) },
      }),
    ),
  );
  const refusals = [
    ...source.refusals.map(line => `${from.name}: ${line}`),
    ...target.refusals.map(line => `${to.name}: ${line}`),
  ];
  return { offer, source, target, ok: source.ok && target.ok && refusals.length === 0, refusals };
}

/** The steps of a move in order: what the dialog's progress names. */
export type Step = 'sealing' | 'carrying' | 'receiving' | 'finishing' | 'done';

export interface Progress {
  readonly step: Step;
  /** Chunks carried so far and in all (only while `carrying`). */
  readonly chunk?: { readonly done: number; readonly of: number };
}

export interface Moved {
  readonly received: ImportResponse;
  /** Whether the source confirmed its durable fence. An unmarked source NEVER permits starting the target. */
  readonly stub: 'marked' | 'unmarked';
  readonly stubNote?: string;
  /** Retries the source's durable completion before attempting any target start. */
  readonly retryComplete?: () => Promise<Moved>;
}

const octets = (answer: unknown): Uint8Array => {
  if (answer instanceof Uint8Array) return answer;
  throw new MoveStopped('A machine sent a chunk that is not ciphertext, so the move stopped.');
};

/**
 * Imports a stopped target, confirms the source's durable fence, then starts the target. A missing fence answer leaves
 * the target stopped with an actionable receipt. Once completion may have committed, source expiry never resumes it.
 */
export async function carry(
  ferret: string,
  from: Machine,
  to: Machine,
  reviewed: Review,
  options: { readonly cloneInto?: string; readonly onProgress?: (progress: Progress) => void } = {},
): Promise<Moved> {
  const say = (progress: Progress): void => options.onProgress?.(progress);
  if (!reviewed.ok) throw new MoveStopped('This move was refused, so nothing was sent.');
  if (Date.parse(reviewed.offer.expiresAt) <= Date.now())
    throw new MoveStopped(`${to.name}’s offer ran out. Start the move again.`, to.daemon);

  say({ step: 'sealing' });
  const sealed = ExportResponseSchema.parse(
    await on(from, () =>
      from.client.call('POST /v1/relocate/:ferretId/export', {
        params: { ferretId: ferret },
        body: { offer: reviewed.offer },
      }),
    ),
  );
  const total = sealed.header.chunks;
  for (let index = 0; index < total; index += 1) {
    say({ step: 'carrying', chunk: { done: index, of: total } });
    const chunk = octets(
      await on(from, () =>
        from.client.call('GET /v1/relocate/exports/:exportId/chunks/:index', {
          params: { exportId: sealed.exportId, index: String(index) },
        }),
      ),
    );
    await on(to, () =>
      to.client.call('PUT /v1/relocate/offers/:offerId/chunks/:index', {
        params: { offerId: reviewed.offer.offerId, index: String(index) },
        body: { chunk: toBase64Url(chunk) },
      }),
    );
  }
  say({ step: 'carrying', chunk: { done: total, of: total } });

  say({ step: 'receiving' });
  const received = ImportResponseSchema.parse(
    await on(to, () =>
      to.client.call('POST /v1/relocate/offers/:offerId/import', {
        params: { offerId: reviewed.offer.offerId },
        body: {
          header: sealed.header,
          sourceDaemonId: from.daemon,
          ...(options.cloneInto === undefined ? {} : { cloneInto: options.cloneInto }),
        },
      }),
    ),
  );

  say({ step: 'finishing' });
  const moved = await finishMove(from, to, sealed.exportId, received);
  say({ step: 'done' });
  return moved;
}

async function finishMove(from: Machine, to: Machine, exportId: string, imported: ImportResponse): Promise<Moved> {
  let received = imported;
  let moved: Moved = { received, stub: 'marked' };
  try {
    await on(from, () =>
      from.client.call('POST /v1/relocate/exports/:exportId/complete', {
        params: { exportId },
        body: { to: { daemonId: to.daemon, ferretId: received.ferretId, machine: to.name } },
      }),
    );
  } catch (error) {
    const why = sentenceOf(error);
    received = {
      ...received,
      recovery: {
        code: 'source_unconfirmed',
        state: 'stopped',
        message: `Moved, not started: ${why}. ${from.name} has not confirmed its fence; its current state is unknown. A daemon restart can forget an unfinished transfer. Check ${from.name}; do not resume both copies. Retry completion to confirm its fence before starting ${to.name}, or release the interrupted move on ${from.name} to leave it stopped. Keep this receipt.${received.recovery === undefined ? '' : ` ${received.recovery.message}`}`,
      },
    };
    moved = {
      received,
      stub: 'unmarked',
      stubNote: why,
      retryComplete: async () => await finishMove(from, to, exportId, imported),
    };
  }
  if (moved.stub === 'marked' && received.recovery === undefined) {
    try {
      await on(to, () =>
        to.client.call('POST /v1/relocate/imports/:ferretId/start', { params: { ferretId: received.ferretId } }),
      );
    } catch (error) {
      received = {
        ...received,
        recovery: {
          code: 'start_unconfirmed',
          state: 'unknown',
          message: `The source is fenced read-only. ${sentenceOf(error)}. Open ${to.name} to check whether it started before explicitly resuming it; keep this receipt.`,
        },
      };
      moved = { received, stub: 'marked' };
    }
  }
  return moved;
}

/** The two halves of the table a person reads: what moves and what stays, with the refusals first. */
export interface Table {
  readonly moves: readonly MoveRow[];
  readonly stays: readonly MoveRow[];
  /** What this machine will leave behind by name: ignored top-level names and new files named like a secret. */
  readonly left: readonly string[];
  readonly files: number;
  readonly bytes: number;
}

export const tableOf = (view: PreflightResponse): Table => ({
  moves: view.moves,
  stays: view.stays,
  left: [...view.ignored, ...view.withheld],
  files: view.files,
  bytes: view.bytes,
});

/** A size a person reads: `12 KB`, `3.4 MB`. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()} ${units[unit] ?? 'GB'}`;
}
