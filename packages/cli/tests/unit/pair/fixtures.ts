import {
  type PairingCodeMintResponse,
  PairingCodeMintResponseSchema,
  type PairingCodeStatusResponse,
  type PairingId,
} from '@ferretry/protocol';
import type {
  IBrowserOpener,
  IPairClock,
  IPairExit,
  IPairGateway,
  IPairProgress,
  IPairScreen,
  IQrEncoder,
  ITerminalSize,
} from '../../../src/lib/pair/ports';

export const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}`;
export const PAIRING_ID = `fy_pair_${'c'.repeat(22)}` as PairingId;
const DAEMON_URL = 'https://box.tailnet-abc.ts.net';
export const CODE = '7F3K-Q2ND';
const PAIR_URL = `https://ferretry.pages.dev/pair#v1;url=${encodeURIComponent(DAEMON_URL)};code=${CODE};fp=${encodeURIComponent(DAEMON_ID)}`;

/**
 * A mint as the daemon really answers it — built through the protocol schema, so a fixture can never
 * drift into a shape the daemon could not produce.
 */
export const MINT: PairingCodeMintResponse = PairingCodeMintResponseSchema.parse({
  pairingId: PAIRING_ID,
  code: CODE,
  ttlSeconds: 120,
  expiresAt: '2026-08-03T21:02:00.000Z',
  daemonId: DAEMON_ID,
  daemonName: 'workstation',
  daemonUrl: DAEMON_URL,
  pairUrl: PAIR_URL,
});

/** The instant two minutes before the fixture mint dies. */
export const MINTED_AT = Date.parse('2026-08-03T21:00:00.000Z');

export class CapturingScreen implements IPairScreen {
  readonly writes: string[] = [];

  write(text: string): void {
    this.writes.push(text);
  }

  get text(): string {
    return this.writes.join('\n');
  }
}

export class RecordingProgress implements IPairProgress {
  readonly events: string[] = [];

  start(text: string): void {
    this.events.push(`start:${text}`);
  }

  succeed(text: string): void {
    this.events.push(`succeed:${text}`);
  }

  fail(text: string): void {
    this.events.push(`fail:${text}`);
  }

  /** The last settled line, which is the one the operator is left looking at. */
  get ending(): string | undefined {
    return this.events.filter(event => !event.startsWith('start:')).at(-1);
  }
}

export class CapturingExit implements IPairExit {
  code: number | undefined;

  setExitCode(code: number): void {
    this.code = code;
  }
}

/** A clock that only moves when a sleep is awaited, so a two-minute countdown costs no time. */
export class FakeClock implements IPairClock {
  readonly slept: number[] = [];

  constructor(private current = MINTED_AT) {}

  now(): number {
    return this.current;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.slept.push(milliseconds);
    this.current += milliseconds;
    await Promise.resolve();
  }
}

export class StubQrEncoder implements IQrEncoder {
  readonly requests: Array<{ value: string; size: string }> = [];

  constructor(private readonly rendered = '█▀█\n█▄█') {}

  async encode(value: string, size: 'compact' | 'large'): Promise<string> {
    this.requests.push({ value, size });
    return await Promise.resolve(this.rendered);
  }
}

export class FixedTerminalSize implements ITerminalSize {
  constructor(private readonly width: number | undefined) {}

  columns(): number | undefined {
    return this.width;
  }
}

/**
 * A daemon that answers the queued statuses in order and repeats the last one forever.
 *
 * A queued `Error` is thrown instead, which is how an unreachable daemon mid-countdown is expressed.
 */
export class ScriptedPairGateway implements IPairGateway {
  minted = 0;
  readonly polled: string[] = [];

  constructor(
    private readonly answers: ReadonlyArray<PairingCodeStatusResponse | Error> = [
      { pairingId: PAIRING_ID, status: 'pending', expiresAt: MINT.expiresAt },
    ],
    private readonly mint_: PairingCodeMintResponse | Error = MINT,
  ) {}

  async mint(): Promise<PairingCodeMintResponse> {
    this.minted += 1;
    if (this.mint_ instanceof Error) throw this.mint_;
    return await Promise.resolve(this.mint_);
  }

  async status(pairingId: PairingId): Promise<PairingCodeStatusResponse> {
    this.polled.push(pairingId);
    const answer = this.answers[Math.min(this.polled.length - 1, this.answers.length - 1)];
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error('no scripted answer');
    return await Promise.resolve(answer);
  }
}

/** The `redeemed` status, which is the ending the whole command exists to report. */
export const redeemed = (deviceName = 'Pixel'): PairingCodeStatusResponse => ({
  pairingId: PAIRING_ID,
  status: 'redeemed',
  expiresAt: MINT.expiresAt,
  redeemedAt: '2026-08-03T21:00:30.000Z',
  deviceName,
});

/** The `pending` and `expired` statuses, which differ only in what they mean. */
export const pending: PairingCodeStatusResponse = {
  pairingId: PAIRING_ID,
  status: 'pending',
  expiresAt: MINT.expiresAt,
};
export const expired: PairingCodeStatusResponse = {
  pairingId: PAIRING_ID,
  status: 'expired',
  expiresAt: MINT.expiresAt,
};

/**
 * A browser that records what it was asked to open and answers a fixed verdict.
 *
 * The verdict is the interesting axis: a host that CANNOT open a browser is an
 * ordinary host, not a failure, and the controller has to say two different
 * things about the two outcomes without either of them being an error.
 */
export class RecordingBrowserOpener implements IBrowserOpener {
  readonly opened: string[] = [];

  constructor(private readonly succeeds = true) {}

  async open(url: string): Promise<boolean> {
    this.opened.push(url);
    return await Promise.resolve(this.succeeds);
  }
}
