import type { AgendaId, InputTargetFacts, LoginObservation, PhoneApprovalRaise } from '@ferretry/protocol';
import { PhoneApprovalRaiseSchema } from '@ferretry/protocol';
import type { BrowserPushNumberRead } from '../../../src/lib/browser/transport/input-contracts.ts';
import {
  type PhoneApprovalAudit,
  type PhoneApprovalCard,
  PhoneApprovalService,
} from '../../../src/lib/input-requests/phone-approval.ts';
import type { InputCaller, ObserveResult } from '../../../src/lib/input-requests/ports.ts';
import type { SavedListing } from '../../../src/lib/input-requests/saved-logins.ts';

/** A phone-approval service over fakes, shared by the service tests and the owner routes' tests. */

export const SESSION = 'session-1';
export const START = Date.parse('2026-11-01T10:00:00.000Z');
export const OWNER: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
export const AGENT: InputCaller = { kind: 'agent', sessionId: SESSION };

export const SI_CLICKUP = 'si_00000000000000c1';
export const SI_OKTA = 'si_00000000000000c2';
export const SI_AWS = 'si_00000000000000c3';

/**
 * ClickUp signs in via the company's Okta; the Okta account signs in at company.okta.com; AWS is a terminal sign-in
 * (okta-aws-cli on this machine). ClickUp's account has one push key.
 */
export const LISTING = {
  accounts: [
    {
      id: 'CLICKUP',
      label: 'ClickUp',
      username: 'a@gmail.com',
      factors: [{ id: 'tf_000000000001', kind: 'push', label: 'Okta Verify on Pixel', app: 'okta-verify' }],
    },
    { id: 'OKTA', label: 'Okta', username: 'a@company.com', factors: [] },
    { id: 'AWS', label: 'AWS', factors: [] },
  ],
  signIns: [
    {
      id: SI_CLICKUP,
      account: 'CLICKUP',
      place: { kind: 'site', domains: ['app.clickup.com'], match: [] },
      via: { account: { id: 'OKTA', label: 'Okta' }, signIn: SI_OKTA },
      observed: [{ at: 'company.okta.com', surface: 'page', identity: 'feedfacefeedface' }],
    },
    { id: SI_OKTA, account: 'OKTA', place: { kind: 'site', domains: ['company.okta.com'], match: [] } },
    { id: SI_AWS, account: 'AWS', place: { kind: 'terminal', tool: 'okta-aws-cli', host: 'kirin-box' } },
  ],
} as unknown as SavedListing;

export const read = (
  origin: string,
  navigationId: string,
  extra: Partial<BrowserPushNumberRead> = {},
): BrowserPushNumberRead => ({ origin, navigationId, ...extra });
export const okta = (
  value: string,
  navigationId = 'doc-1',
  origin = 'https://company.okta.com',
): BrowserPushNumberRead =>
  read(origin, navigationId, {
    provider: 'okta',
    number: { value, from: 'okta', frameOrigin: origin },
  });

export const terminalFacts = (promptLine: string, comm = 'okta-aws-cli'): InputTargetFacts =>
  ({
    kind: 'terminal',
    paneProof: { paneId: '%3', pid: 1 },
    foreground: { pid: 2, pgid: 2, comm, argv: comm },
    echo: 'on',
    cursorRow: 0,
    promptLine,
    promptLineDigest: promptLine.padEnd(64, '0').slice(0, 64),
    program: comm,
    canonical: true,
    recognisedConsumer: false,
  }) as unknown as InputTargetFacts;

/** A clock that moves only when the test ticks, and timers that fire when it reaches them. */
export function world(options: { readonly enabled?: boolean; readonly listing?: SavedListing } = {}) {
  let now = START;
  let pending: { at: number; resolve: () => void }[] = [];
  let ids = 0;
  const page: { current?: { pageId: string; read: BrowserPushNumberRead } } = {
    current: { pageId: 'page-1', read: okta('42') },
  };
  const terminal: { current: ObserveResult } = {
    current: { ok: true, facts: terminalFacts('Waiting for approval…'), names: ['%3'] },
  };
  const cards: { sessionId: string; card: PhoneApprovalCard }[] = [];
  const closed: { id: AgendaId; note: string }[] = [];
  const pushes: { body: string; sequence: number; secondsLeft: number }[] = [];
  const told: string[] = [];
  const audits: Parameters<PhoneApprovalAudit['record']>[0][] = [];
  const facts: { signIn: string; seen: LoginObservation }[] = [];
  const looks: (PhoneApprovalRaise['element'] | undefined)[] = [];
  /** `fail`: how many of the observer's next answers throw, as a look that cannot be made. */
  const acted = { scripted: false, since: Number.NEGATIVE_INFINITY, terminalSince: Number.NEGATIVE_INFINITY, fail: 0 };
  const service = new PhoneApprovalService({
    pages: {
      look: async (_session, _key, element) => {
        looks.push(element);
        return page.current;
      },
    },
    terminals: { observe: async () => terminal.current },
    agenda: {
      raise: async (sessionId, card) => {
        cards.push({ sessionId, card });
        return { ok: true, id: `A${String(cards.length)}` as AgendaId };
      },
      close: async (_session, id, note) => {
        closed.push({ id, note });
      },
      open: async () => ['A7' as AgendaId],
    },
    push: {
      push: async (_session, _agenda, approval) => {
        pushes.push({ body: approval.body, sequence: approval.sequence, secondsLeft: approval.secondsLeft });
      },
    },
    notifier: {
      tell: async (_session, _agenda, message) => {
        told.push(message);
      },
    },
    audit: {
      record: async entry => {
        audits.push(entry);
      },
    },
    clock: { now: () => now },
    timers: {
      after: async milliseconds =>
        await new Promise<void>(resolve => pending.push({ at: now + milliseconds, resolve })),
    },
    ids: () => `pa_${(ids++).toString(16).padStart(24, '0')}`,
    observer: {
      tainted: (_session, kind, since) => {
        if (acted.fail > 0) {
          acted.fail -= 1;
          throw new Error('the observer could not tell');
        }
        return kind === 'browser' ? acted.scripted || acted.since >= since : acted.terminalSince >= since;
      },
    },
    logins: { listing: async () => options.listing ?? LISTING },
    facts: {
      observeSignIn: async (signIn, seen) => {
        facts.push({ signIn, seen });
      },
    },
    hostName: 'kirin-box',
    enabled: () => options.enabled ?? true,
  });
  const flush = async (): Promise<void> => {
    for (let round = 0; round < 4; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
  };
  /** Moves the clock a second and lets the watch take its look. */
  const tick = async (milliseconds = 1_000): Promise<void> => {
    now += milliseconds;
    const due = pending.filter(timer => timer.at <= now);
    pending = pending.filter(timer => timer.at > now);
    for (const timer of due) timer.resolve();
    await flush();
  };
  const raise = async (raise: Record<string, unknown> = {}) =>
    await service.raise(
      SESSION,
      'lizzette',
      PhoneApprovalRaiseSchema.parse({ target: { kind: 'browser', key: 'app' }, secretHint: 'CLICKUP', ...raise }),
    );
  const actNow = (kind: 'browser' | 'terminal') => {
    if (kind === 'browser') acted.since = now;
    else acted.terminalSince = now;
  };
  return { service, page, terminal, cards, closed, pushes, told, audits, facts, looks, acted, tick, raise, actNow };
}
