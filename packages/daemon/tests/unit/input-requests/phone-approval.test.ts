import { describe, it } from 'bun:test';
import type { AgendaId, InputTargetFacts, LoginObservation, PhoneApprovalRaise } from '@ferretry/protocol';
import { PhoneApprovalRaiseSchema } from '@ferretry/protocol';
import should from 'should';
import type { BrowserPushNumberRead } from '../../../src/lib/browser/transport/input-contracts.ts';
import { PhoneApprovalAuditAdapter } from '../../../src/lib/input-requests/audit-adapter.ts';
import { InputRequestError } from '../../../src/lib/input-requests/errors.ts';
import {
  gatedNumber,
  type PhoneApprovalAudit,
  type PhoneApprovalCard,
  PhoneApprovalService,
} from '../../../src/lib/input-requests/phone-approval.ts';
import type { InputCaller, ObserveResult } from '../../../src/lib/input-requests/ports.ts';
import type { SavedListing } from '../../../src/lib/input-requests/saved-logins.ts';
import { phoneApprovalRoutes } from '../../../src/lib/runtime/mounts/input-requests.ts';

const SESSION = 'session-1';
const START = Date.parse('2026-11-01T10:00:00.000Z');
const OWNER: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const AGENT: InputCaller = { kind: 'agent', sessionId: SESSION };

const SI_CLICKUP = 'si_00000000000000c1';
const SI_OKTA = 'si_00000000000000c2';
const SI_AWS = 'si_00000000000000c3';

/**
 * ClickUp signs in via the company's Okta; the Okta account signs in at company.okta.com; AWS is a terminal sign-in
 * (okta-aws-cli on this machine). ClickUp's account has one push key.
 */
const LISTING = {
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

const read = (
  origin: string,
  navigationId: string,
  extra: Partial<BrowserPushNumberRead> = {},
): BrowserPushNumberRead => ({ origin, navigationId, ...extra });
const okta = (value: string, navigationId = 'doc-1', origin = 'https://company.okta.com'): BrowserPushNumberRead =>
  read(origin, navigationId, {
    provider: 'okta',
    number: { value, from: 'okta', frameOrigin: origin },
  });

const terminalFacts = (promptLine: string, comm = 'okta-aws-cli'): InputTargetFacts =>
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
function world(options: { readonly enabled?: boolean; readonly listing?: SavedListing } = {}) {
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
  const acted = { scripted: false, since: Number.NEGATIVE_INFINITY, terminalSince: Number.NEGATIVE_INFINITY };
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
      tainted: (_session, kind, since) =>
        kind === 'browser' ? acted.scripted || acted.since >= since : acted.terminalSince >= since,
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

describe('PhoneApprovalService raise', () => {
  it('should refuse a raise until the app that draws the card ships', async () => {
    // Arrange
    const { raise, cards } = world({ enabled: false });

    // Act
    const refused = await raise().catch((error: unknown) => error);

    // Assert
    should(refused).be.instanceOf(InputRequestError);
    should((refused as InputRequestError).code).equal('unavailable');
    should((refused as InputRequestError).message).match(/update the app/u);
    should(cards).be.empty();
  });

  it('should show the number the browser read on the sign-in’s provider page, named via the provider', async () => {
    // Arrange
    const { raise, service, cards, pushes } = world();

    // Act
    const view = await raise();
    const approval = service.get(OWNER, SESSION, view.id);

    // Assert — every fact on the card is the daemon's own.
    should(approval).containDeep({
      surface: 'browser',
      origin: 'https://company.okta.com',
      signIn: SI_CLICKUP,
      account: { id: 'CLICKUP', label: 'ClickUp' },
      username: 'a@gmail.com',
      via: { id: 'OKTA', label: 'Okta' },
      factor: { id: 'tf_000000000001', label: 'Okta Verify on Pixel', app: 'okta-verify' },
      number: { value: '42', from: 'okta', direction: 'tap-on-phone' },
      agentName: 'lizzette',
      state: 'waiting',
    });
    should(cards[0]?.card).containDeep({
      approvalId: view.id,
      title: 'Approve on your phone',
      subject: 'Approve on your phone: ClickUp · a@gmail.com',
    });
    should(pushes).eql([{ body: 'Tap 42 on your phone: ClickUp · a@gmail.com', sequence: 0, secondsLeft: 120 }]);
  });

  it('should never tell the ferret the number, nor put it in the agenda card (invariant 8)', async () => {
    // Arrange
    const { raise, service, cards } = world();

    // Act
    const view = await raise();
    const waited = await service.agentView(SESSION, view.id, 0);

    // Assert
    should(view).eql({ id: view.id, state: 'waiting' });
    should(JSON.stringify(waited)).not.match(/42/u);
    should(JSON.stringify(cards)).not.match(/\b42\b/u);
  });

  it('should read no number on a page that is neither the sign-in’s nor an identity provider’s (an AitM proxy)', async () => {
    // Arrange — the real Okta and Microsoft DOM, behind proxies of the attacker's.
    const proxied = [
      okta('42', 'doc-1', 'https://company.okta.com.evil.example'),
      read('https://login.microsoftonline.com.evil.example', 'doc-1', {
        provider: 'microsoft',
        number: { value: '42', from: 'microsoft', frameOrigin: 'https://login.microsoftonline.com.evil.example' },
      }),
      okta('42', 'doc-1', 'http://company.okta.com'),
      okta('42', 'doc-1', 'https://company.okta.com:8443'),
    ];

    for (const page of proxied) {
      const run = world();
      run.page.current = { pageId: 'page-1', read: page };

      // Act
      const view = await run.raise();

      // Assert
      const approval = run.service.get(OWNER, SESSION, view.id);
      should(approval.number).be.undefined();
      should(approval.numberMissing).equal('origin');
      should(run.pushes[0]?.body).not.match(/42/u);
    }
  });

  it('should read no number in a session whose ferret ran a page script', async () => {
    // Arrange
    const run = world();
    run.acted.scripted = true;

    // Act
    const view = await run.raise();

    // Assert
    should(run.service.get(OWNER, SESSION, view.id)).containDeep({ numberMissing: 'scripted' });
    should(run.pushes[0]?.body).equal('Approve on your phone: ClickUp · a@gmail.com — open for the number');
  });

  it('should read no number from a page that changed while it was read, a frame of another origin or the wrong provider', () => {
    // Arrange
    const context = { domains: new Set(['company.okta.com']), scripted: false, now: START };
    const changed = read('https://company.okta.com', 'doc-2', { missing: 'changed' });
    const framed = read('https://company.okta.com', 'doc-1', {
      number: { value: '42', from: 'okta', frameOrigin: 'https://evil.example' },
    });
    const wrongProvider = read('https://company.okta.com', 'doc-1', {
      number: { value: '42', from: 'microsoft', frameOrigin: 'https://company.okta.com' },
    });
    const tooLong = read('https://company.okta.com', 'doc-1', {
      number: { value: '4242', from: 'okta', frameOrigin: 'https://company.okta.com' },
    });
    const editable = read('https://company.okta.com', 'doc-1', { missing: 'editable' });

    // Act + Assert
    should(gatedNumber(changed, context)).eql({ numberMissing: 'changed' });
    should(gatedNumber(framed, context)).eql({ numberMissing: 'origin' });
    should(gatedNumber(wrongProvider, context)).eql({ numberMissing: 'origin' });
    should(gatedNumber(tooLong, context)).eql({ numberMissing: 'none-found' });
    should(gatedNumber(editable, context)).eql({ numberMissing: 'editable' });
    should(gatedNumber(okta('42'), context)).containDeep({ number: { value: '42', from: 'okta' } });
  });

  it('should name a sign-in it does not know by its host on the card, and never in the push', async () => {
    // Arrange — no saved account signs in at this Microsoft page.
    const run = world({ listing: { accounts: [], signIns: [] } });
    run.page.current = {
      pageId: 'page-1',
      read: read('https://login.microsoftonline.com', 'doc-1', {
        provider: 'microsoft',
        number: { value: '17', from: 'microsoft', frameOrigin: 'https://login.microsoftonline.com' },
      }),
    };

    // Act
    await run.raise({ secretHint: undefined });

    // Assert
    should(run.cards[0]?.card.subject).equal(
      "Approve on your phone: a sign-in Ferretry doesn't know, on login.microsoftonline.com",
    );
    should(run.pushes[0]?.body).equal("Tap 17 on your phone: a sign-in Ferretry doesn't know");
  });

  it('should mark a number read from the element the ferret pointed at, and look only where it pointed', async () => {
    // Arrange
    const run = world();
    run.page.current = {
      pageId: 'page-1',
      read: read('https://company.okta.com', 'doc-1', {
        number: { value: '7', from: 'pointed', frameOrigin: 'https://company.okta.com' },
      }),
    };

    // Act
    await run.raise({ element: { kind: 'ref', ref: 'e12' } });

    // Assert
    should(run.looks[0]).eql({ kind: 'ref', ref: 'e12' });
    should(run.pushes[0]?.body).equal('Tap 7 on your phone (read where the ferret pointed): ClickUp · a@gmail.com');
  });

  it('should never show a number for a terminal, whatever the pane says (invariant 9)', async () => {
    // Arrange — the ferret printed a "number" into its own pane.
    const run = world();
    run.terminal.current = { ok: true, facts: terminalFacts('Number challenge: 42'), names: ['%3'] };

    // Act
    const view = await run.service.raise(
      SESSION,
      'lizzette',
      PhoneApprovalRaiseSchema.parse({ target: { kind: 'terminal', key: 'aws' } }),
    );

    // Assert
    const approval = run.service.get(OWNER, SESSION, view.id);
    should(approval).containDeep({ surface: 'terminal', numberMissing: 'terminal', signIn: SI_AWS });
    should(approval.number).be.undefined();
    should(JSON.stringify([approval, run.cards, run.pushes])).not.match(/42/u);
    should(run.pushes[0]?.body).equal('Approve on your phone: AWS — check the terminal');
  });

  it('should keep one approval per page waiting', async () => {
    // Arrange
    const run = world();
    await run.raise();

    // Act
    const again = await run.raise().catch((error: unknown) => error);

    // Assert
    should((again as InputRequestError).code).equal('conflict');
  });
});

describe('PhoneApprovalService settling (invariant 10)', () => {
  it('should end moved-on only when the page shows a document past the challenge, and keep the push fact', async () => {
    // Arrange
    const run = world();
    const view = await run.raise();

    // Act — the same document a while; then the app.
    await run.tick();
    await run.tick();
    const waiting = run.service.get(OWNER, SESSION, view.id).state;
    run.page.current = { pageId: 'page-1', read: read('https://app.clickup.com', 'doc-2') };
    await run.tick();

    // Assert
    should(waiting).equal('waiting');
    should(await run.service.agentView(SESSION, view.id, 0)).eql({
      id: view.id,
      state: 'moved-on',
      secondFactor: 'push',
    });
    should(run.closed).eql([{ id: 'A1', note: 'The sign-in went through.' }]);
    // Kept under the identity the sign-in already has there, so its other facts are counted up, not replaced.
    should(run.facts).eql([
      {
        signIn: SI_CLICKUP,
        seen: { at: 'company.okta.com', surface: 'page', identity: 'feedfacefeedface', secondFactor: 'push' },
      },
    ]);
    should(run.audits.map(entry => entry.event)).eql(['phone-approval.raised', 'phone-approval.settled']);
  });

  it('should keep no fact and claim no push when the ferret acted on a page since the raise', async () => {
    // Arrange
    const run = world();
    const view = await run.raise();
    await run.tick();
    run.actNow('browser');

    // Act
    run.page.current = { pageId: 'page-1', read: read('https://app.clickup.com', 'doc-2') };
    await run.tick();

    // Assert
    should(await run.service.agentView(SESSION, view.id, 0)).eql({ id: view.id, state: 'moved-on' });
    should(run.facts).be.empty();
    should(run.audits.at(-1)).containDeep({ event: 'phone-approval.settled', steered: true });
  });

  it('should end moved-on when a provider’s challenge gives way to a page with none on the same host', async () => {
    // Arrange — Microsoft's number, then its "Stay signed in?" page.
    const run = world({ listing: { accounts: [], signIns: [] } });
    const ms = 'https://login.microsoftonline.com';
    run.page.current = {
      pageId: 'page-1',
      read: read(ms, 'doc-1', { provider: 'microsoft', number: { value: '17', from: 'microsoft', frameOrigin: ms } }),
    };
    const view = await run.raise({ secretHint: undefined });

    // Act
    run.page.current = { pageId: 'page-1', read: read(ms, 'doc-2') };
    await run.tick();

    // Assert
    should(run.service.get(OWNER, SESSION, view.id).state).equal('moved-on');
  });

  it('should clear the number on a new document of the same challenge, and push again only for a new number', async () => {
    // Arrange
    const run = world();
    const view = await run.raise();

    // Act — the site re-sends the push: a new document, the same challenge, a new number; then that number again.
    run.page.current = { pageId: 'page-1', read: okta('17', 'doc-2') };
    await run.tick();
    const after = run.service.get(OWNER, SESSION, view.id);
    await run.tick();
    run.page.current = { pageId: 'page-1', read: read('https://company.okta.com', 'doc-3', { provider: 'okta' }) };
    await run.tick();
    const cleared = run.service.get(OWNER, SESSION, view.id);

    // Assert
    should(after).containDeep({ state: 'waiting', number: { value: '17' } });
    should(run.pushes.map(push => [push.sequence, push.body])).eql([
      [0, 'Tap 42 on your phone: ClickUp · a@gmail.com'],
      [1, 'Tap 17 on your phone: ClickUp · a@gmail.com'],
    ]);
    should(cleared.number).be.undefined();
    should(cleared.numberMissing).equal('none-found');
  });

  it('should time out, close its card and say so to a waiting ferret', async () => {
    // Arrange
    const run = world();
    const view = await run.raise({ waitSeconds: 30 });

    // Act
    for (let second = 0; second < 31; second += 1) await run.tick();

    // Assert
    should(run.service.get(OWNER, SESSION, view.id).state).equal('timed-out');
    should(run.closed[0]?.note).match(/in time/u);
  });

  it('should end gone when the page closes or the name is another page', async () => {
    // Arrange
    const run = world();
    const view = await run.raise();

    // Act
    run.page.current = { pageId: 'page-2', read: okta('42') };
    await run.tick();

    // Assert
    should(run.service.get(OWNER, SESSION, view.id).state).equal('gone');
  });

  it('should end a terminal moved-on when its prompt changes, with no push fact after a ferret keystroke', async () => {
    // Arrange
    const run = world();
    const view = await run.service.raise(
      SESSION,
      'lizzette',
      PhoneApprovalRaiseSchema.parse({ target: { kind: 'terminal', key: 'aws' } }),
    );
    await run.tick();
    run.actNow('terminal');

    // Act
    run.terminal.current = { ok: true, facts: terminalFacts('$ '), names: ['%3'] };
    await run.tick();

    // Assert
    should(await run.service.agentView(SESSION, view.id, 0)).eql({ id: view.id, state: 'moved-on' });
    should(run.facts).be.empty();
  });

  it('should let only the owner say "Not me", which stops the ferret and is logged', async () => {
    // Arrange
    const run = world();
    const view = await run.raise();

    // Act
    const byAgent = await run.service.refuse(AGENT, SESSION, view.id).catch((error: unknown) => error);
    const refused = await run.service.refuse(OWNER, SESSION, view.id);

    // Assert
    should((byAgent as InputRequestError).code).equal('forbidden');
    should(refused.state).equal('refused');
    should(run.told[0]).match(/stop/u);
    should(run.closed[0]?.note).match(/Deny it on your phone too/u);
    should(run.audits.at(-1)).containDeep({ event: 'phone-approval.refused', actor: { kind: 'host' } });
  });

  it('should have no route that sets an approval moved-on: the owner reads one and refuses it, nothing else', () => {
    // Arrange
    const { service } = world();

    // Act
    const routes = phoneApprovalRoutes(service).map(route => `${route.method} ${route.path}`);

    // Assert
    should(routes).eql([
      'GET /v1/phone-approvals',
      'GET /v1/sessions/:sessionId/phone-approvals/:approvalId',
      'POST /v1/sessions/:sessionId/phone-approvals/:approvalId/refuse',
    ]);
  });

  it('should close every card that presents an approval when it starts, since none survives a restart', async () => {
    // Arrange
    const run = world();

    // Act
    await run.service.restore([SESSION]);

    // Assert
    should(run.closed.map(each => each.id)).eql(['A7']);
  });
});

describe('PhoneApprovalAuditAdapter', () => {
  it('should log the account, the site and the ferret, and never the number', async () => {
    // Arrange
    const records: unknown[] = [];
    const run = world();
    const view = await run.raise();
    const adapter = new PhoneApprovalAuditAdapter({
      record: async record => {
        records.push(record);
      },
    } as ConstructorParameters<typeof PhoneApprovalAuditAdapter>[0]);

    // Act
    await adapter.record({
      event: 'phone-approval.raised',
      actor: { kind: 'agent' },
      approval: run.service.get(OWNER, SESSION, view.id),
    });

    // Assert
    should(records[0]).containDeep({
      event: 'phone-approval.raised',
      subject: SESSION,
      detail: { account: 'CLICKUP', site: 'company.okta.com', ferret: 'lizzette', numberFrom: 'okta' },
    });
    should(JSON.stringify(records)).not.match(/42/u);
  });
});
