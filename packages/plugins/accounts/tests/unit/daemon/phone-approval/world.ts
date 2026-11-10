/**
 * A phone approval's world for its tests: the real service over the real account directory (in memory), with the
 * Vault's looks, the card, the push, the log and the clock as fakes the test drives. Nothing here touches a disk, the
 * network or a real tmux.
 */
import type { ObserveResult, PushNumberRead } from '@ferretry/core-vault/contract';
import type { Place } from '../../../../contract/routes/index.ts';
import { PhoneApprovalRaiseSchema } from '../../../../contract/routes/index.ts';
import type { PhoneApprovalAuditEvent } from '../../../../daemon/lib/phone-approval/ports.ts';
import { PhoneApprovalService } from '../../../../daemon/lib/phone-approval/service.ts';
import { CountingSealed, daemonOver, MemoryLoginIndex } from '../support.ts';

export const FERRET = 'lizzette';
export const OTHER_FERRET = 'britnee';
export const OKTA_HOST = 'company.okta.com';
export const OKTA_ORIGIN = `https://${OKTA_HOST}`;

/** A number as Okta's own challenge view shows it, read by the browser. */
export const oktaRead = (value = '42', navigationId = 'doc-1'): PushNumberRead => ({
  origin: OKTA_ORIGIN,
  navigationId,
  provider: 'okta',
  number: { value, from: 'okta', frameOrigin: OKTA_ORIGIN },
});

/** The same host after the challenge ended: a new document, no provider's view. */
export const afterChallenge = (navigationId = 'doc-2'): PushNumberRead => ({
  origin: OKTA_ORIGIN,
  navigationId,
});

/** A terminal at a line-mode `sudo` prompt, as the input bridge observes it. */
export const terminalSeen = (prompt = 'a'.repeat(64), program = 'ssh'): ObserveResult => ({
  ok: true,
  names: ['%1'],
  facts: {
    kind: 'terminal',
    paneProof: { kind: 'tmux', paneId: '%1', pid: 1, startedAt: 1 },
    foreground: { pid: 2, pgid: 2, comm: program, argv: `${program} build.example.com` },
    echo: 'off',
    cursorRow: 0,
    promptLine: 'Password:',
    promptLineDigest: prompt,
    program,
    recognisedConsumer: true,
    canonical: true,
    trustedProgram: true,
  } as never,
});

/** A clock and timers the test advances by hand; a timer fires only when the clock passes it. */
class ManualTime {
  now = Date.parse('2026-11-10T12:00:00.000Z');
  private readonly waiting: { readonly at: number; readonly wake: () => void }[] = [];
  readonly clock = { now: (): number => this.now };
  readonly timers = {
    after: (ms: number): Promise<void> =>
      new Promise(resolve => {
        this.waiting.push({ at: this.now + ms, wake: resolve });
      }),
  };

  async settle(): Promise<void> {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = this.waiting.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.waiting.splice(this.waiting.indexOf(due), 1);
      this.now = Math.max(this.now, due.at);
      due.wake();
      await this.settle();
    }
    this.now = end;
    await this.settle();
  }
}

interface AuditNote {
  readonly event: PhoneApprovalAuditEvent;
  readonly actor: unknown;
  readonly approval: unknown;
  readonly steered?: boolean | undefined;
}

export interface WorldOptions {
  /** A sign-in at Okta's own host, with this username. Absent: the sign-in is unknown to Ferretry. */
  readonly saved?: boolean;
  /** Whether the Vault's `tainted` says the ferret steered the surface. */
  readonly steered?: () => boolean;
}

/** Every approval world: build it, drive `time`, change `page`/`terminal`, and read what the fakes recorded. */
export async function phoneWorld(options: WorldOptions = {}) {
  const time = new ManualTime();
  const daemon = daemonOver(new MemoryLoginIndex(), new CountingSealed());
  let signIn: string | undefined;
  if (options.saved === true) {
    await daemon.directory.putAccount('OKTA', { label: 'Okta', username: 'me@company.test' });
    const place: Place = { kind: 'site', domains: [OKTA_HOST], match: [OKTA_HOST] };
    signIn = (await daemon.directory.addSignIn('OKTA', { place })).id;
  }
  const state = {
    page: { pageId: 'p1', read: oktaRead() } as { pageId: string; read: PushNumberRead } | undefined,
    terminal: terminalSeen() as ObserveResult,
    steered: options.steered ?? (() => false),
    openCards: [] as { ferret: string; id: string }[],
    cardFails: undefined as string | undefined,
    pushFails: false,
    clearFails: false,
    auditFails: false,
    lookFails: false,
    observeFails: false,
  };
  const looked: unknown[][] = [];
  const cards: { ferret: string; card: Record<string, string> }[] = [];
  const closed: { ferret: string; id: string; reason: string }[] = [];
  const pushes: { ferret: string; askId: string; approval: Record<string, unknown> }[] = [];
  const clears: { ferret: string; id: string }[] = [];
  const audit: AuditNote[] = [];
  const asked: { ferret: string; kind: string; since: number }[] = [];
  const told: { ferret: string; message: string }[] = [];
  let next = 0;
  const service = new PhoneApprovalService({
    pages: {
      look: async (...args) => {
        looked.push(args);
        if (state.lookFails && looked.length > 1) throw new Error('the browser is busy');
        return state.page;
      },
    },
    terminals: {
      observe: async () => {
        if (state.observeFails) throw new Error('tmux is busy');
        return state.terminal;
      },
    },
    asks: {
      raise: async (ferret, card) => {
        if (state.cardFails !== undefined) return { ok: false, message: state.cardFails };
        cards.push({ ferret, card: { ...card } });
        return { ok: true, id: `ask-${String(cards.length)}` };
      },
      close: async (ferret, id, reason) => {
        closed.push({ ferret, id, reason });
      },
      open: async () => state.openCards,
    },
    push: {
      push: async (ferret, askId, approval) => {
        if (state.pushFails) throw new Error('the push service is down');
        pushes.push({ ferret, askId, approval: { ...approval } });
      },
      clear: async (ferret, id) => {
        if (state.clearFails) throw new Error('the push service is down');
        clears.push({ ferret, id });
      },
    },
    audit: {
      record: async entry => {
        if (state.auditFails) throw new Error('the log cannot be written');
        audit.push(entry);
      },
    },
    clock: time.clock,
    timers: time.timers,
    ids: () => `pa_${(++next).toString(16).padStart(24, '0')}`,
    observer: {
      tainted: (ferret, kind, since) => {
        asked.push({ ferret, kind, since });
        return state.steered();
      },
    },
    logins: { listing: async () => await daemon.directory.list() },
    facts: daemon.directory,
    notifier: {
      tell: async (ferret, message) => {
        told.push({ ferret, message });
      },
    },
    hostName: 'kirin-box.local',
  });
  return {
    service,
    time,
    state,
    directory: daemon.directory,
    signIn,
    looked,
    cards,
    closed,
    pushes,
    clears,
    audit,
    asked,
    told,
    /** A browser raise on the page named `login`, as the Vault hands it. */
    raiseBrowser: async (ferret = FERRET, extra: Record<string, unknown> = {}) =>
      await service.raise(
        ferret,
        ferret,
        PhoneApprovalRaiseSchema.parse({ target: { kind: 'browser', key: 'login' }, ...extra }),
      ),
    raiseTerminal: async (ferret = FERRET) =>
      await service.raise(
        ferret,
        ferret,
        PhoneApprovalRaiseSchema.parse({ target: { kind: 'terminal', key: 'build' } }),
      ),
    /** The approval as the owner's card reads it. */
    seen: (id: string, ferret = FERRET) => service.get({ kind: 'owner', actor: { kind: 'host' } }, ferret, id),
  };
}

export const OWNER = { kind: 'owner', actor: { kind: 'host' } } as const;

export const AGENT = { kind: 'agent' } as const;
