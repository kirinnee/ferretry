import { describe, it } from 'bun:test';
import { PhoneApprovalRaiseSchema } from '@ferretry/protocol';
import should from 'should';
import { PhoneApprovalAuditAdapter } from '../../../src/lib/input-requests/audit-adapter.ts';
import { InputRequestError } from '../../../src/lib/input-requests/errors.ts';
import { gatedNumber } from '../../../src/lib/input-requests/phone-approval.ts';
import type { SavedListing } from '../../../src/lib/input-requests/saved-logins.ts';
import { phoneApprovalRoutes } from '../../../src/lib/runtime/mounts/input-requests.ts';
import {
  AGENT,
  LISTING,
  OWNER,
  okta,
  read,
  SESSION,
  SI_AWS,
  SI_CLICKUP,
  SI_OKTA,
  START,
  terminalFacts,
  world,
} from './phone-approval-support.ts';

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
    // A number from no provider's own challenge view (an element the page merely shows): never believed.
    const unrecognised = read('https://company.okta.com', 'doc-1', {
      number: { value: '42', from: 'okta', frameOrigin: 'https://company.okta.com' },
    });
    const anotherHost = okta('42', 'doc-1', 'https://other.okta.com');

    // Act + Assert
    should(gatedNumber(changed, context)).eql({ numberMissing: 'changed' });
    should(gatedNumber(framed, context)).eql({ numberMissing: 'origin' });
    should(gatedNumber(wrongProvider, context)).eql({ numberMissing: 'origin' });
    should(gatedNumber(tooLong, context)).eql({ numberMissing: 'none-found' });
    should(gatedNumber(unrecognised, context)).eql({ numberMissing: 'none-found' });
    should(gatedNumber(anotherHost, { ...context, pinnedHost: 'company.okta.com' })).eql({ numberMissing: 'origin' });
    should(gatedNumber(okta('42'), context)).containDeep({ number: { value: '42', from: 'okta' } });
    // Okta's widget off Okta's own hosts: only on a provider sign-in's custom domain (secrev-1244 R1).
    const custom = okta('42', 'doc-1', 'https://login.company.com');
    const onCustom = { ...context, domains: new Set(['login.company.com']) };
    should(gatedNumber(custom, onCustom)).eql({ numberMissing: 'origin' });
    should(gatedNumber(custom, { ...onCustom, providerDomains: new Set(['login.company.com']) })).containDeep({
      number: { value: '42', from: 'okta' },
    });
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

  it('should never read where the ferret pointed: a username it typed and Okta echoes is no number (secrev-1244 H1)', async () => {
    // Arrange — the ferret typed "42" as the username on the owner's real Okta page and points at Okta's echo of it. The
    // page is Okta's push page with no number of its own, so whatever reaches the daemon is no challenge view's number.
    const run = world();
    run.page.current = {
      pageId: 'page-1',
      read: read('https://company.okta.com', 'doc-1', {
        number: { value: '42', from: 'okta', frameOrigin: 'https://company.okta.com' },
      }),
    };

    // Act
    const view = await run.raise({ element: { kind: 'selector', selector: '[data-se="identifier"] span' } });

    // Assert — only the page's key is looked at, and neither the card nor the push carries a number.
    const approval = run.service.get(OWNER, SESSION, view.id);
    should(run.looks).eql(['app']);
    should(approval.number).be.undefined();
    should(approval.numberMissing).equal('none-found');
    should(run.pushes[0]?.body).equal('Approve on your phone: ClickUp · a@gmail.com — open for the number');
    should(JSON.stringify([approval, run.cards, run.pushes])).not.match(/\b42\b/u);
  });

  it('should read nothing on another host than the one it was raised on, even another identity provider’s (M1)', async () => {
    // Arrange
    const run = world();
    const view = await run.raise();

    // Act — the page goes to another Okta tenant, still a challenge, with a number of its own.
    run.page.current = { pageId: 'page-1', read: okta('17', 'doc-2', 'https://other.okta.com') };
    await run.tick();

    // Assert
    const approval = run.service.get(OWNER, SESSION, view.id);
    should(approval.state).equal('waiting');
    should(approval.number).be.undefined();
    should(approval.numberMissing).equal('origin');
    should(run.pushes).have.length(1);
  });

  it('should keep watching when the raise cannot be logged, so the approval still times out (L1)', async () => {
    // Arrange
    const run = world({ auditFails: true });

    // Act
    const view = await run.raise({ waitSeconds: 30 });
    for (let second = 0; second < 31; second += 1) await run.tick();

    // Assert
    should(run.service.get(OWNER, SESSION, view.id).state).equal('timed-out');
    should(run.pushes).have.length(1);
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

  it('should say whether a session has an approval waiting on the phone, and no for another session', async () => {
    // Arrange
    const run = world();
    const before = run.service.hasOpen(SESSION);

    // Act
    await run.raise();

    // Assert
    should(before).be.false();
    should(run.service.hasOpen(SESSION)).be.true();
    should(run.service.hasOpen('other-session')).be.false();
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
    should(run.closed).eql([{ id: 'A1', note: 'The page moved on.' }]);
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

  it('should show no number from a new document after the ferret acted on its pages (R2)', async () => {
    // Arrange — the ferret restarts the challenge (a click, a reload) hoping for the number an attacker's push shows.
    const run = world();
    const view = await run.raise();
    run.actNow('browser');

    // Act
    run.page.current = { pageId: 'page-1', read: okta('17', 'doc-2') };
    await run.tick();

    // Assert — the card says why, and the phone hears nothing more.
    const approval = run.service.get(OWNER, SESSION, view.id);
    should(approval.state).equal('waiting');
    should(approval.number).be.undefined();
    should(approval.numberMissing).equal('steered');
    should(run.pushes).have.length(1);
  });

  it('should still read the page it was raised on after the ferret acted elsewhere', async () => {
    // Arrange
    const run = world();
    const view = await run.raise();
    run.actNow('browser');

    // Act — the same document, its number unchanged.
    await run.tick();

    // Assert
    should(run.service.get(OWNER, SESSION, view.id).number?.value).equal('42');
  });

  it('should read Okta’s widget on a custom domain only when the chain reaches it as a provider (R1)', async () => {
    // Arrange — the Okta account signs in at its custom domain; ClickUp goes via it; a third site of ClickUp's own.
    const listing = {
      accounts: LISTING.accounts,
      signIns: LISTING.signIns.map(each =>
        each.id === SI_OKTA
          ? { ...each, place: { kind: 'site', domains: ['login.company.com'], match: [] } }
          : each.id === SI_CLICKUP
            ? { ...each, place: { kind: 'site', domains: ['app.clickup.com', 'wiki.clickup.com'], match: [] } }
            : each,
      ),
    } as SavedListing;
    const raiseOn = async (origin: string, hint?: string) => {
      const run = world({ listing });
      run.page.current = { pageId: 'page-1', read: okta('42', 'doc-1', origin) };
      const view = await run.raise(hint === undefined ? { secretHint: undefined } : { secretHint: hint });
      return run.service.get(OWNER, SESSION, view.id);
    };

    // Act
    const viaProvider = await raiseOn('https://login.company.com', 'CLICKUP');
    const directly = await raiseOn('https://login.company.com');
    const ownSite = await raiseOn('https://wiki.clickup.com', 'CLICKUP');

    // Assert — the provider's custom domain reached through the chain reads; the matched sign-in's own domains do not.
    should(viaProvider).containDeep({ via: { id: 'OKTA' }, number: { value: '42', from: 'okta' } });
    should(directly.number).be.undefined();
    should(directly.numberMissing).equal('origin');
    should(ownSite.number).be.undefined();
    should(ownSite.numberMissing).equal('origin');
  });

  it('should claim nothing when the provider’s challenge gives way on its own host, which may be its denial (L2)', async () => {
    // Arrange — Okta's number, then a page on the same host that is no challenge (its "denied" view, say).
    const run = world();
    const view = await run.raise();

    // Act
    run.page.current = { pageId: 'page-1', read: read('https://company.okta.com', 'doc-2') };
    await run.tick();

    // Assert — the card ends, says only that the page moved on, and keeps no fact and tells the ferret no push.
    should(await run.service.agentView(SESSION, view.id, 0)).eql({ id: view.id, state: 'moved-on' });
    should(run.closed).eql([{ id: 'A1', note: 'The page moved on.' }]);
    should(run.facts).be.empty();
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

describe('PhoneApprovalService refusals and the owner’s reads', () => {
  it('should refuse a raise on a page or terminal the session does not have', async () => {
    // Arrange
    const run = world();
    run.page.current = undefined;
    run.terminal.current = { ok: false, reason: 'target_gone' };

    // Act
    const page = await run.raise().catch((error: unknown) => error);
    const terminal = await run.service
      .raise(SESSION, 'lizzette', PhoneApprovalRaiseSchema.parse({ target: { kind: 'terminal', key: 'aws' } }))
      .catch((error: unknown) => error);

    // Assert
    should((page as InputRequestError).code).equal('not_found');
    should((terminal as InputRequestError).code).equal('not_found');
    should(run.cards).be.empty();
  });

  it('should keep two approvals waiting per session and ten raises an hour', async () => {
    // Arrange
    const waiting = world();
    const hourly = world();
    await waiting.raise({ target: { kind: 'browser', key: 'one' } });
    await waiting.raise({ target: { kind: 'browser', key: 'two' } });
    for (let n = 0; n < 10; n += 1) {
      const view = await hourly.raise();
      await hourly.service.refuse(OWNER, SESSION, view.id);
    }

    // Act
    const third = await waiting.raise({ target: { kind: 'browser', key: 'three' } }).catch((error: unknown) => error);
    const eleventh = await hourly.raise().catch((error: unknown) => error);

    // Assert
    should((third as InputRequestError).code).equal('capacity');
    should((third as InputRequestError).message).match(/already has phone approvals waiting/u);
    should((eleventh as InputRequestError).code).equal('capacity');
    should((eleventh as InputRequestError).message).match(/last hour/u);
  });

  it('should list the waiting approvals oldest first and read one, for the owner only and in its own session', async () => {
    // Arrange
    const run = world();
    const first = await run.raise({ target: { kind: 'browser', key: 'one' } });
    await run.tick();
    const second = await run.raise({ target: { kind: 'browser', key: 'two' } });
    await run.service.refuse(OWNER, SESSION, first.id);

    // Act
    const listed = run.service.list(OWNER).map(approval => approval.id);
    const mine = run.service.list(OWNER, SESSION).map(approval => approval.id);
    const other = run.service.list(OWNER, 'session-2');
    const byAgent = (() => {
      try {
        return run.service.list(AGENT);
      } catch (error) {
        return error;
      }
    })();
    const elsewhere = (() => {
      try {
        return run.service.get(OWNER, 'session-2', second.id);
      } catch (error) {
        return error;
      }
    })();
    const unknownRefusal = await run.service
      .refuse(OWNER, SESSION, `pa_${'f'.repeat(24)}`)
      .catch((error: unknown) => error);
    const unknownWait = await run.service.agentView(SESSION, first.id.replace('0', 'f'), 0).catch((e: unknown) => e);
    const again = await run.service.refuse(OWNER, SESSION, first.id);

    // Assert — a refused one is no longer listed, and refusing it again leaves it as it ended.
    should(listed).eql([second.id]);
    should(mine).eql([second.id]);
    should(other).be.empty();
    should((byAgent as InputRequestError).code).equal('forbidden');
    should((elsewhere as InputRequestError).code).equal('not_found');
    should((unknownRefusal as InputRequestError).code).equal('not_found');
    should((unknownWait as InputRequestError).code).equal('not_found');
    should(again.state).equal('refused');
    should(run.told).have.length(1);
  });

  it('should wake a ferret waiting on its approval the moment it ends', async () => {
    // Arrange
    const run = world();
    const view = await run.raise();
    const waited = run.service.agentView(SESSION, view.id, 30_000);

    // Act
    await run.service.refuse(OWNER, SESSION, view.id);

    // Assert
    should(await waited).eql({ id: view.id, state: 'refused' });
  });

  it('should end a session’s approvals with it and forget them', async () => {
    // Arrange
    const run = world();
    const view = await run.raise();

    // Act
    const before = run.service.sessions();
    await run.service.sessionEnded(SESSION);

    // Assert
    should(before).eql([SESSION]);
    should(run.service.sessions()).be.empty();
    should(run.closed[0]?.note).equal('The page or terminal closed.');
    should(run.audits.at(-1)).containDeep({
      event: 'phone-approval.settled',
      approval: { id: view.id, state: 'gone' },
    });
  });
});

describe('PhoneApprovalService matching and watching edges', () => {
  it('should name no account when the provider a chain reaches is not saved, or the chain never reaches the page', async () => {
    // Arrange — the Okta account is gone from the listing; and a chain that loops back on itself.
    const orphan = world({ listing: { ...LISTING, accounts: LISTING.accounts.filter(each => each.id !== 'OKTA') } });
    const looping = world({
      listing: {
        accounts: LISTING.accounts,
        signIns: LISTING.signIns.map(each =>
          each.id === SI_OKTA
            ? { ...each, via: { account: { id: 'CLICKUP', label: 'ClickUp' }, signIn: SI_CLICKUP } }
            : each,
        ),
      } as SavedListing,
    });
    const microsoft = 'https://login.microsoftonline.com';
    looping.page.current = { pageId: 'page-1', read: read(microsoft, 'doc-1', { provider: 'microsoft' }) };

    // Act
    const one = await orphan.raise();
    const two = await looping.raise();

    // Assert
    should(orphan.service.get(OWNER, SESSION, one.id).account).be.undefined();
    should(looping.service.get(OWNER, SESSION, two.id).account).be.undefined();
  });

  it('should keep the push fact under a fresh identity where the sign-in has none yet', async () => {
    // Arrange — no hint: the Okta sign-in matches the page itself, and has no facts there.
    const run = world();
    await run.raise({ secretHint: undefined });

    // Act
    run.page.current = { pageId: 'page-1', read: read('https://app.clickup.com', 'doc-2') };
    await run.tick();

    // Assert
    should(run.facts).have.length(1);
    should(run.facts[0]).containDeep({ signIn: SI_OKTA, seen: { at: 'company.okta.com', secondFactor: 'push' } });
    should(run.facts[0]?.seen.identity).match(/^[0-9a-f]{16}$/u);
    should(run.facts[0]?.seen.identity).not.equal('feedfacefeedface');
  });

  it('should keep watching after a look that cannot be made', async () => {
    // Arrange
    const run = world();
    const view = await run.raise();
    run.acted.fail = 1;

    // Act — the first look fails; the page then moves on.
    await run.tick();
    run.page.current = { pageId: 'page-1', read: read('https://app.clickup.com', 'doc-2') };
    for (let second = 0; second < 3; second += 1) await run.tick();

    // Assert
    should(run.service.get(OWNER, SESSION, view.id).state).equal('moved-on');
  });

  it('should end a terminal’s approval gone when its pane closes', async () => {
    // Arrange
    const run = world();
    const view = await run.service.raise(
      SESSION,
      'lizzette',
      PhoneApprovalRaiseSchema.parse({ target: { kind: 'terminal', key: 'aws' } }),
    );

    // Act
    run.terminal.current = { ok: false, reason: 'target_gone' };
    await run.tick();

    // Assert
    should(run.service.get(OWNER, SESSION, view.id).state).equal('gone');
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
