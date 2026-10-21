/**
 * Fakes for the tunnel carrier's ports: time a test advances by hand, a `cloudflared` that says what a
 * test tells it to, and a hosted provisioner that VERIFIES what it is sent with the shared transcript
 * code — so a test that passes proves the daemon signed for the right host, not merely that it called.
 */

import {
  type DaemonIdentity,
  fromBase64UrlFixed,
  NONCE_BYTES,
  type TunnelChallenge,
  type TunnelChallengeRequest,
  type TunnelProvision,
  type TunnelProvisionRequest,
  type TunnelRelease,
  type TunnelReleaseRequest,
  toBase64Url,
  verifyTunnelRequest,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import type {
  ConnectorCommand,
  ConnectorProcess,
  ConnectorProcessPort,
  ProvisionerAnswer,
  ScheduledAction,
  TunnelProvisionerPort,
  TunnelScheduler,
} from '../../../src/lib/tunnel/index.ts';

export const testCrypto = new WebCryptoRelayCrypto();

/** A fresh daemon identity, the way the daemon imports its own. */
export async function newDaemonIdentity(): Promise<DaemonIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return await testCrypto.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join('\n'),
  );
}

interface Armed {
  readonly milliseconds: number;
  readonly action: () => void;
  cancelled: boolean;
}

/** Timers that fire only when the test says so. */
export class ManualScheduler implements TunnelScheduler {
  readonly #armed: Armed[] = [];

  after(milliseconds: number, action: () => void): ScheduledAction {
    const entry: Armed = { milliseconds, action, cancelled: false };
    this.#armed.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  /** The delays of every timer still armed, in the order they were armed. */
  get armed(): readonly number[] {
    return this.#armed.filter(entry => !entry.cancelled).map(entry => entry.milliseconds);
  }

  /** Fires every armed timer once, oldest first, and answers their delays. */
  fire(): readonly number[] {
    const due = this.#armed.splice(0).filter(entry => !entry.cancelled);
    for (const entry of due) entry.action();
    return due.map(entry => entry.milliseconds);
  }
}

/** One fake `cloudflared` child. `terminate` ends it unless the case made it stubborn. */
export class FakeConnector implements ConnectorProcess {
  readonly exited: Promise<number | null>;
  terminated = false;
  #settle: (code: number | null) => void = () => undefined;

  constructor(
    readonly command: ConnectorCommand,
    private readonly onLine: (line: string) => void,
    private readonly stubborn: boolean,
  ) {
    this.exited = new Promise(resolve => {
      this.#settle = resolve;
    });
  }

  say(line: string): void {
    this.onLine(line);
  }

  exit(code: number | null): void {
    this.#settle(code);
  }

  terminate(): void {
    this.terminated = true;
    if (!this.stubborn) this.#settle(null);
  }
}

export class FakeConnectorProcesses implements ConnectorProcessPort {
  readonly spawned: FakeConnector[] = [];
  /** Thrown by the next spawn, as `Bun.spawn` throws for a binary it cannot start. */
  failNext: unknown;
  stubborn = false;

  spawn(command: ConnectorCommand, onLine: (line: string) => void): ConnectorProcess {
    if (this.failNext !== undefined) {
      const failure = this.failNext;
      this.failNext = undefined;
      throw failure;
    }
    const child = new FakeConnector(command, onLine, this.stubborn);
    this.spawned.push(child);
    return child;
  }

  get latest(): FakeConnector {
    const child = this.spawned.at(-1);
    if (child === undefined) throw new Error('no connector was spawned');
    return child;
  }
}

/** A registration line, as `cloudflared` 2026 prints one. */
export const registered = (index: number) =>
  `2026-10-21T10:00:00Z INF Registered tunnel connection connIndex=${String(index)} connection=abc event=0 ip=198.41.200.13 location=lhr01 protocol=quic`;
export const unregistered = (index: number) =>
  `2026-10-21T10:05:00Z WRN Unregistered tunnel connection connIndex=${String(index)} error="context canceled"`;

type Scripted<T> = ProvisionerAnswer<T> | ((request: unknown) => ProvisionerAnswer<T>);

/**
 * The hosted provisioner, verifying every signed request over ITS OWN host with the shared transcript
 * code — the check the real Worker makes. A request signed for any other host fails here as it would
 * there, which is what makes "refuses to sign another host" testable from both sides.
 */
export class FakeProvisioner implements TunnelProvisionerPort {
  readonly challenges: TunnelChallengeRequest[] = [];
  readonly provisions: TunnelProvisionRequest[] = [];
  readonly releases: TunnelReleaseRequest[] = [];
  readonly verdicts: boolean[] = [];
  challengeAnswers: Scripted<TunnelChallenge>[] = [];
  provisionAnswers: Scripted<TunnelProvision>[] = [];
  releaseAnswers: Scripted<TunnelRelease>[] = [];
  #nonce = new Uint8Array(NONCE_BYTES);
  #counter = 0;

  constructor(
    readonly origin: string,
    private readonly provision_: (request: TunnelProvisionRequest) => TunnelProvision = () => provisionOf(),
    /** The host the SERVICE rebuilds the transcript from; its own origin's unless a case says otherwise. */
    private readonly verifyAs: string = new URL(origin).host,
  ) {}

  async challenge(request: TunnelChallengeRequest): Promise<ProvisionerAnswer<TunnelChallenge>> {
    this.challenges.push(request);
    const scripted = this.challengeAnswers.shift();
    if (scripted !== undefined) return typeof scripted === 'function' ? scripted(request) : scripted;
    this.#counter += 1;
    this.#nonce = new Uint8Array(NONCE_BYTES).fill(this.#counter);
    return { kind: 'ok', value: { version: 1, nonce: toBase64Url(this.#nonce), deadlineSeconds: 60 } };
  }

  async provision(request: TunnelProvisionRequest): Promise<ProvisionerAnswer<TunnelProvision>> {
    this.provisions.push(request);
    await this.#verify('provision', request, request.originPort);
    const scripted = this.provisionAnswers.shift();
    if (scripted !== undefined) return typeof scripted === 'function' ? scripted(request) : scripted;
    return { kind: 'ok', value: this.provision_(request) };
  }

  async release(request: TunnelReleaseRequest): Promise<ProvisionerAnswer<TunnelRelease>> {
    this.releases.push(request);
    await this.#verify('release', request, undefined);
    const scripted = this.releaseAnswers.shift();
    if (scripted !== undefined) return typeof scripted === 'function' ? scripted(request) : scripted;
    return { kind: 'ok', value: { version: 1, released: true } };
  }

  async #verify(
    action: 'provision' | 'release',
    request: TunnelReleaseRequest,
    originPort: number | undefined,
  ): Promise<void> {
    const nonce = fromBase64UrlFixed(request.nonce, NONCE_BYTES) ?? new Uint8Array();
    const verdict = await verifyTunnelRequest(
      testCrypto,
      {
        action,
        daemonId: request.daemonId,
        host: this.verifyAs,
        nonce,
        ...(originPort === undefined ? {} : { originPort }),
      },
      request,
    );
    this.verdicts.push(verdict.ok);
  }
}

/** A provision answer. The token is fake and exists only to be looked for where it must not be. */
export function provisionOf(overrides: Partial<TunnelProvision> = {}): TunnelProvision {
  return {
    version: 1,
    tunnelUrl: 'https://quiet-otter.tunnels.example',
    connectorToken: 'fake-connector-token-ONE',
    renewAfterSeconds: 86_400,
    ...overrides,
  };
}

/** Lines a carrier said, by kind, in order. */
export class RecordedNotices {
  readonly steps: string[] = [];
  readonly stated: string[] = [];

  step(what: string, detail?: string): void {
    this.steps.push(detail === undefined ? what : `${what}: ${detail}`);
  }

  state(line: string): void {
    this.stated.push(line);
  }

  /** Everything said, for asserting that a secret never was. */
  get all(): string {
    return [...this.steps, ...this.stated].join('\n');
  }
}
