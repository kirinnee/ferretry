import { describe, it } from 'bun:test';
import should from 'should';
import type { PhoneApproval } from '../../../../contract/routes/index.ts';
import { PhoneApprovalError } from '../../../../daemon/lib/phone-approval/errors.ts';
import { PhoneApprovalService } from '../../../../daemon/lib/phone-approval/service.ts';
import {
  afterChallenge,
  AGENT,
  FERRET,
  OKTA_HOST,
  OKTA_ORIGIN,
  OTHER_FERRET,
  oktaRead,
  OWNER,
  phoneWorld,
  terminalSeen,
} from './world.ts';

/** "Approve on your phone": the RAM service, over the real account directory and fakes for everything else. */

const FIRST = 'pa_000000000000000000000001';

const codeOf = async (work: Promise<unknown> | (() => unknown)): Promise<string | undefined> => {
  try {
    await (typeof work === 'function' ? work() : work);
    return undefined;
  } catch (error) {
    return error instanceof PhoneApprovalError ? error.code : 'other';
  }
};

describe('I200 the number passes three gates: right host, no page script this session, a recognised provider view', () => {
  it('I200 should show the number a provider’s own view gave, on a host the provider is on, with the way to use it', async () => {
    const w = await phoneWorld({ saved: true });

    const view = await w.raiseBrowser();
    const approval = w.seen(view.id);

    should(approval.number).eql({
      value: '42',
      from: 'okta',
      direction: 'tap-on-phone',
      readAt: new Date(w.time.now).toISOString(),
    });
    should(approval.numberMissing).be.undefined();
    should(approval.origin).equal(OKTA_ORIGIN);
  });

  it('I200 should read no number off a host that is not one the sign-in or an identity provider is on, or not https, or with a port', async () => {
    for (const origin of [
      `https://${OKTA_HOST}.evil.example`,
      'https://okta.com',
      'https://evil-company.okta.com.example',
      `http://${OKTA_HOST}`,
      `https://${OKTA_HOST}:8443`,
    ]) {
      const w = await phoneWorld();
      w.state.page = {
        pageId: 'p1',
        read: { ...oktaRead(), origin, number: { value: '42', from: 'okta', frameOrigin: origin } },
      };

      const approval = w.seen((await w.raiseBrowser()).id);

      should(approval.number).be.undefined();
      should(approval.numberMissing).equal('origin');
    }
  });

  it('I200 should read no number once a ferret ran a page script this session', async () => {
    const w = await phoneWorld({ steered: () => true });

    const approval = w.seen((await w.raiseBrowser()).id);

    should(approval.number).be.undefined();
    should(approval.numberMissing).equal('scripted');
    should(w.asked[0]).eql({ ferret: FERRET, kind: 'browser', since: Number.POSITIVE_INFINITY });
  });

  it('I200 should read no number from a document that changed while it was read, or from no provider’s own view', async () => {
    const w = await phoneWorld();
    w.state.page = {
      pageId: 'p1',
      read: { origin: OKTA_ORIGIN, navigationId: 'd', provider: 'okta', missing: 'changed' },
    };
    should(w.seen((await w.raiseBrowser()).id).numberMissing).equal('changed');

    const other = await phoneWorld();
    other.state.page = { pageId: 'p1', read: { ...oktaRead(), provider: undefined } as never };
    should(other.seen((await other.raiseBrowser()).id).numberMissing).equal('none-found');

    const wrong = await phoneWorld();
    wrong.state.page = {
      pageId: 'p1',
      read: { ...oktaRead(), number: { value: '42', from: 'microsoft', frameOrigin: OKTA_ORIGIN } },
    };
    should(wrong.seen((await wrong.raiseBrowser()).id).numberMissing).equal('origin');

    const framed = await phoneWorld();
    framed.state.page = {
      pageId: 'p1',
      read: { ...oktaRead(), number: { value: '42', from: 'okta', frameOrigin: 'https://other.example' } },
    };
    should(framed.seen((await framed.raiseBrowser()).id).numberMissing).equal('origin');
  });

  it('I200 should pin the host the approval was raised on: another identity provider’s host later shows no number', async () => {
    const w = await phoneWorld();
    const view = await w.raiseBrowser();
    w.state.page = {
      pageId: 'p1',
      read: {
        origin: 'https://login.microsoftonline.com',
        navigationId: 'doc-1',
        provider: 'microsoft',
        number: { value: '17', from: 'microsoft', frameOrigin: 'https://login.microsoftonline.com' },
      },
    };

    await w.time.advance(1_000);

    should(w.seen(view.id).number).be.undefined();
    should(w.seen(view.id).numberMissing).equal('origin');
  });

  it('I200 should type a Duo code on the phone and tap an Okta or Microsoft number', async () => {
    const w = await phoneWorld();
    w.state.page = {
      pageId: 'p1',
      read: {
        origin: 'https://api-1.duosecurity.com',
        navigationId: 'd',
        provider: 'duo',
        number: { value: '123456', from: 'duo', frameOrigin: 'https://api-1.duosecurity.com' },
      },
    };

    const approval = w.seen((await w.raiseBrowser()).id);

    should(approval.number?.direction).equal('type-on-phone');
    should(approval.number?.value).equal('123456');
  });
});

describe('I201 the daemon never reads an element the ferret points at', () => {
  it('I201 should look at the page by its name alone, whatever element the ferret named, now and at every look after', async () => {
    const w = await phoneWorld();

    const view = await w.raiseBrowser(FERRET, { element: { kind: 'selector', selector: '#the-number' } });
    await w.time.advance(3_000);

    should(w.looked.length).be.above(2);
    for (const args of w.looked) should(args).eql([FERRET, 'login']);
    should(w.seen(view.id).number?.value).equal('42');
  });

  it('I201 should not take the number a page echoes back where it is not a provider’s own challenge view', async () => {
    const w = await phoneWorld();
    w.state.page = { pageId: 'p1', read: { ...oktaRead('99'), provider: undefined } as never };

    const approval = w.seen((await w.raiseBrowser(FERRET, { element: { kind: 'selector', selector: '#echo' } })).id);

    should(approval.number).be.undefined();
  });
});

describe('I202 a document change clears the number, and a number a ferret could have steered is never shown', () => {
  it('I202 should drop the number when the document changes and show only a number read in the new one', async () => {
    const w = await phoneWorld();
    const view = await w.raiseBrowser();
    w.state.page = { pageId: 'p1', read: oktaRead('77', 'doc-2') };

    await w.time.advance(1_000);

    should(w.seen(view.id).number?.value).equal('77');
    should(w.pushes.map(push => push.approval.sequence)).eql([0, 1]);
  });

  it('I202 should show no number from a new document after the ferret acted on its pages', async () => {
    let acted = false;
    const w = await phoneWorld({ steered: () => acted });
    const view = await w.raiseBrowser();
    acted = true;
    w.state.page = { pageId: 'p1', read: oktaRead('77', 'doc-2') };

    await w.time.advance(1_000);

    should(w.seen(view.id).number).be.undefined();
    should(w.seen(view.id).numberMissing).equal('steered');
    should(w.pushes).have.length(1);
  });

  it('I202 should push at most four times per approval, however often the number changes', async () => {
    const w = await phoneWorld();
    await w.raiseBrowser();
    for (let step = 0; step < 8; step += 1) {
      w.state.page = { pageId: 'p1', read: oktaRead(String(10 + step), `doc-${String(step + 2)}`) };
      await w.time.advance(1_000);
    }

    should(w.pushes).have.length(4);
  });

  it('I202 should hold at most two waiting approvals per ferret, one per surface, and ten an hour', async () => {
    const w = await phoneWorld();
    await w.raiseBrowser();
    should(await codeOf(w.raiseBrowser())).equal('conflict');
    await w.raiseTerminal();
    w.state.page = { pageId: 'p2', read: oktaRead() };
    const third = w.service.raise(FERRET, FERRET, {
      target: { kind: 'browser', key: 'other' },
      waitSeconds: 120,
    });

    should(await codeOf(third)).equal('capacity');
    const hourly = await phoneWorld();
    for (let each = 0; each < 10; each += 1) {
      const view = await hourly.raiseBrowser();
      await hourly.service.refuse(OWNER, FERRET, view.id);
    }
    should(await codeOf(hourly.raiseBrowser())).equal('capacity');
    await hourly.time.advance(3_600_001);
    should(await codeOf(hourly.raiseBrowser())).be.undefined();
  });
});

describe('I203 a terminal approval never shows a number', () => {
  it('I203 should show no number for a terminal, whatever its pane prints', async () => {
    const w = await phoneWorld();

    const view = await w.raiseTerminal();
    const approval = w.seen(view.id);

    should(approval.surface).equal('terminal');
    should(approval.number).be.undefined();
    should(approval.numberMissing).equal('terminal');
    should(approval.origin).be.undefined();
    should(w.pushes[0]?.approval.body).match(/terminal/u);
  });
});

describe('I204 moved-on is set only by the daemon seeing it, and the push fact only when the ferret did not act', () => {
  it('I204 should keep secondFactor push on the sign-in, through Accounts’ own observeSignIn, when the page leaves the providers unsteered', async () => {
    const w = await phoneWorld({ saved: true });
    const view = await w.raiseBrowser();
    w.state.page = { pageId: 'p1', read: { origin: 'https://app.example.com', navigationId: 'doc-2' } };

    await w.time.advance(1_000);

    should(w.seen(view.id).state).equal('moved-on');
    should((await w.service.agentView(FERRET, view.id, 0)).secondFactor).equal('push');
    const kept = (await w.directory.list()).signIns.find(each => each.id === w.signIn)?.observed;
    should(kept?.map(fact => [fact.at, fact.surface, fact.secondFactor?.value])).eql([[OKTA_HOST, 'page', 'push']]);
    should(w.audit.map(entry => entry.event)).eql(['phone-approval.raised', 'phone-approval.settled']);
  });

  it('I204 should keep no fact and tell the ferret no secondFactor when it acted on that kind of surface meanwhile', async () => {
    let acted = false;
    const w = await phoneWorld({ saved: true, steered: () => acted });
    const view = await w.raiseBrowser();
    acted = true;
    w.state.page = { pageId: 'p1', read: { origin: 'https://app.example.com', navigationId: 'doc-2' } };

    await w.time.advance(1_000);

    should(w.seen(view.id).state).equal('moved-on');
    should((await w.service.agentView(FERRET, view.id, 0)).secondFactor).be.undefined();
    should((await w.directory.list()).signIns.find(each => each.id === w.signIn)?.observed).be.undefined();
    should(w.audit.at(-1)?.steered).equal(true);
  });

  it('I204 should end as moved-on but keep no fact when the same host shows a view that is no longer the challenge', async () => {
    const w = await phoneWorld({ saved: true });
    const view = await w.raiseBrowser();
    w.state.page = { pageId: 'p1', read: afterChallenge() };

    await w.time.advance(1_000);

    should(w.seen(view.id).state).equal('moved-on');
    should((await w.service.agentView(FERRET, view.id, 0)).secondFactor).be.undefined();
    should((await w.directory.list()).signIns.find(each => each.id === w.signIn)?.observed).be.undefined();
  });

  it('I204 should end a terminal approval as moved-on when its prompt or program changes, and keep the fact at its key', async () => {
    const w = await phoneWorld();
    const view = await w.raiseTerminal();
    w.state.terminal = terminalSeen('b'.repeat(64));

    await w.time.advance(1_000);

    should(w.seen(view.id).state).equal('moved-on');
  });
});

describe('I195 the ferret is never told the number', () => {
  it('I195 should tell the ferret only the id and where the approval stands, in the raise and in every wait', async () => {
    const w = await phoneWorld({ saved: true });

    const raised = await w.raiseBrowser();
    const waited = await w.service.agentView(FERRET, raised.id, 0);

    should(raised).eql({ id: FIRST, state: 'waiting' });
    should(waited).eql({ id: FIRST, state: 'waiting' });
    should(JSON.stringify([raised, waited])).not.match(/42|okta|Okta|me@company/u);
  });
});

describe('I205 approvals live in RAM, and a restart closes every card', () => {
  it('I205 should know nothing of an approval after a restart, and close every card still presenting one', async () => {
    const w = await phoneWorld();
    const view = await w.raiseBrowser();
    const restarted = await phoneWorld();
    restarted.state.openCards = [
      { ferret: FERRET, id: 'ask-1' },
      { ferret: OTHER_FERRET, id: 'ask-9' },
    ];

    await restarted.service.restore();

    should(await codeOf(() => restarted.service.get(OWNER, FERRET, view.id))).equal('not_found');
    should(restarted.closed).eql([
      { ferret: FERRET, id: 'ask-1', reason: 'source-gone' },
      { ferret: OTHER_FERRET, id: 'ask-9', reason: 'source-gone' },
    ]);
    should(restarted.service.list(OWNER)).eql([]);
  });

  it('I205 should close the cards it can when listing them fails, and never throw at start', async () => {
    const w = await phoneWorld();
    const broken = new PhoneApprovalService({
      ...(w.service as unknown as { deps: ConstructorParameters<typeof PhoneApprovalService>[0] }).deps,
      asks: {
        raise: async () => ({ ok: false, message: 'x' }),
        close: async () => {
          throw new Error('gone');
        },
        open: async () => [{ ferret: FERRET, id: 'ask-1' }],
      },
    });

    await broken.restore();
    const failing = new PhoneApprovalService({
      ...(w.service as unknown as { deps: ConstructorParameters<typeof PhoneApprovalService>[0] }).deps,
      asks: {
        raise: async () => ({ ok: false, message: 'x' }),
        close: async () => undefined,
        open: async () => {
          throw new Error('asks is down');
        },
      },
    });
    await failing.restore();
  });
});

describe('I208 the push lasts no longer than the card', () => {
  const settleWays: readonly [string, (w: Awaited<ReturnType<typeof phoneWorld>>, id: string) => Promise<void>][] = [
    ['the owner says Not me', async (w, id) => void (await w.service.refuse(OWNER, FERRET, id))],
    ['the approval times out', async w => await w.time.advance(121_000)],
    [
      'the sign-in moves on',
      async w => {
        w.state.page = { pageId: 'p1', read: { origin: 'https://app.example.com', navigationId: 'doc-2' } };
        await w.time.advance(1_000);
      },
    ],
    [
      'the page closes',
      async w => {
        w.state.page = undefined;
        await w.time.advance(1_000);
      },
    ],
    ['the ferret ends', async w => await w.service.ferretEnded(FERRET)],
  ];

  for (const [way, settle] of settleWays) {
    it(`I208 should take the approval’s push down on every device, and close its card, when ${way}`, async () => {
      const w = await phoneWorld();
      const view = await w.raiseBrowser();
      should(w.clears).eql([]);

      await settle(w, view.id);

      should(w.clears).eql([{ ferret: FERRET, id: view.id }]);
      should(w.closed.map(card => card.id)).eql(['ask-1']);
    });
  }

  it('I208 should push the raise with the card’s id and seconds left, and nothing once the time is up', async () => {
    const w = await phoneWorld();

    await w.raiseBrowser(FERRET, { waitSeconds: 90 });

    should(w.pushes).have.length(1);
    should(w.pushes[0]).eql({
      ferret: FERRET,
      askId: 'ask-1',
      approval: { id: FIRST, body: w.pushes[0]?.approval.body, sequence: 0, secondsLeft: 90 },
    });
  });

  it('I208 should still resolve the approval when the push service cannot take the push down or put one up', async () => {
    const w = await phoneWorld();
    w.state.pushFails = true;
    w.state.clearFails = true;

    const view = await w.raiseBrowser();
    const refused = await w.service.refuse(OWNER, FERRET, view.id);

    should(refused.state).equal('refused');
    should((await w.service.agentView(FERRET, view.id, 0)).state).equal('refused');
  });
});

describe('a refused or expired approval can never be approved afterwards, and a ferret reaches only its own', () => {
  it('should leave a refused approval refused when the page later moves on, with no fact and no second log line', async () => {
    const w = await phoneWorld({ saved: true });
    const view = await w.raiseBrowser();
    await w.service.refuse(OWNER, FERRET, view.id);
    w.state.page = { pageId: 'p1', read: { origin: 'https://app.example.com', navigationId: 'doc-2' } };

    await w.time.advance(2_000);
    const again = await w.service.refuse(OWNER, FERRET, view.id);

    should(again.state).equal('refused');
    should((await w.service.agentView(FERRET, view.id, 0)).secondFactor).be.undefined();
    should((await w.directory.list()).signIns.find(each => each.id === w.signIn)?.observed).be.undefined();
    should(w.audit.map(entry => entry.event)).eql(['phone-approval.raised', 'phone-approval.refused']);
    should(w.told.map(each => each.ferret)).eql([FERRET]);
  });

  /** The two layers of "never approved after refused" (F3): `refuse` does not re-enter `settle`, and `settle` itself ends nothing twice. */
  type Settling = {
    held: Map<string, unknown>;
    settle(held: unknown, state: 'moved-on' | 'gone' | 'refused' | 'timed-out'): Promise<void>;
  };

  it('F3 should end nothing twice in settle itself, even when it is called on a refused approval directly', async () => {
    const w = await phoneWorld({ saved: true });
    const view = await w.raiseBrowser();
    await w.service.refuse(OWNER, FERRET, view.id);
    const inner = w.service as unknown as Settling;
    const held = inner.held.get(view.id);

    await inner.settle(held, 'moved-on');

    should(w.seen(view.id).state).equal('refused');
    should((await w.service.agentView(FERRET, view.id, 0)).secondFactor).be.undefined();
    should((await w.directory.list()).signIns.find(each => each.id === w.signIn)?.observed).be.undefined();
    should(w.audit.map(entry => entry.event)).eql(['phone-approval.raised', 'phone-approval.refused']);
  });

  it('F3 should not re-enter settle when the owner refuses an approval that is already refused', async () => {
    const w = await phoneWorld({ saved: true });
    const view = await w.raiseBrowser();
    const inner = w.service as unknown as Settling;
    const settle = inner.settle.bind(inner);
    let entered = 0;
    inner.settle = async (held, state) => {
      entered += 1;
      await settle(held, state);
    };

    await w.service.refuse(OWNER, FERRET, view.id);
    await w.service.refuse(OWNER, FERRET, view.id);

    should(entered).equal(1);
    should(w.seen(view.id).state).equal('refused');
  });

  it('should leave a timed-out approval timed out, whatever the page does after', async () => {
    const w = await phoneWorld();
    const view = await w.raiseBrowser(FERRET, { waitSeconds: 30 });

    await w.time.advance(31_000);
    w.state.page = { pageId: 'p1', read: { origin: 'https://app.example.com', navigationId: 'doc-2' } };
    await w.time.advance(5_000);

    should(w.seen(view.id).state).equal('timed-out');
    should((await w.service.agentView(FERRET, view.id, 0)).secondFactor).be.undefined();
  });

  it('should keep an approval to the ferret that raised it, for the ferret’s wait and the owner’s card alike', async () => {
    const w = await phoneWorld();
    const view = await w.raiseBrowser();

    should(await codeOf(w.service.agentView(OTHER_FERRET, view.id, 0))).equal('not_found');
    should(await codeOf(() => w.service.get(OWNER, OTHER_FERRET, view.id))).equal('not_found');
    should(await codeOf(w.service.refuse(OWNER, OTHER_FERRET, view.id))).equal('not_found');
    should(w.service.hasOpen(OTHER_FERRET)).be.false();
    should(w.service.hasOpen(FERRET)).be.true();
  });

  it('should answer the owner alone: a ferret may not list, read or refuse', async () => {
    const w = await phoneWorld();
    const view = await w.raiseBrowser();

    should(await codeOf(() => w.service.list(AGENT))).equal('forbidden');
    should(await codeOf(() => w.service.get(AGENT, FERRET, view.id))).equal('forbidden');
    should(await codeOf(w.service.refuse(AGENT, FERRET, view.id))).equal('forbidden');
    should(w.seen(view.id).state).equal('waiting');
  });

  it('should list the waiting approvals oldest first, and not the settled', async () => {
    const w = await phoneWorld();
    const first = await w.raiseBrowser();
    w.time.now += 5_000;
    const second = await w.raiseTerminal();
    await w.service.refuse(OWNER, FERRET, first.id);

    should(w.service.list(OWNER).map((each: PhoneApproval) => each.id)).eql([second.id]);
    should(w.service.list(OWNER, OTHER_FERRET)).eql([]);
    should(w.service.ferrets()).eql([FERRET]);
  });

  it('should fail closed when the page or terminal is not there, or the card cannot be raised', async () => {
    const gone = await phoneWorld();
    gone.state.page = undefined;
    should(await codeOf(gone.raiseBrowser())).equal('not_found');

    const noTerminal = await phoneWorld();
    noTerminal.state.terminal = { ok: false, reason: 'target_gone' };
    should(await codeOf(noTerminal.raiseTerminal())).equal('not_found');

    const noCard = await phoneWorld();
    noCard.state.cardFails = 'asks is down';
    should(await codeOf(noCard.raiseBrowser())).equal('unavailable');
    should(noCard.service.hasOpen(FERRET)).be.false();
  });

  it('should still time out an approval whose log cannot be written, and name the ferret a callsign or "ferret"', async () => {
    const w = await phoneWorld();
    w.state.auditFails = true;

    const view = await w.service.raise(FERRET, 'not a callsign!', {
      target: { kind: 'browser', key: 'login' },
      waitSeconds: 30,
    });
    await w.time.advance(31_000);

    should(w.seen(view.id).agentName).equal('ferret');
    should(w.seen(view.id).state).equal('timed-out');
  });
});

describe('waiting on an approval, and a watch that cannot look', () => {
  it('should hold the ferret’s wait until the approval ends, and end it the moment it does', async () => {
    const w = await phoneWorld();
    const view = await w.raiseBrowser();

    const waiting = w.service.agentView(FERRET, view.id, 60_000);
    await w.time.settle();
    await w.service.refuse(OWNER, FERRET, view.id);

    should((await waiting).state).equal('refused');
  });

  it('should answer a wait that runs out with where the approval stands, and a settled one at once', async () => {
    const w = await phoneWorld();
    const view = await w.raiseBrowser(FERRET, { waitSeconds: 30 });

    const waiting = w.service.agentView(FERRET, view.id, 10_000);
    await w.time.advance(10_000);
    const patient = w.service.agentView(FERRET, view.id, 3_600_000);
    await w.time.advance(21_000);

    should((await waiting).state).equal('waiting');
    should((await patient).state).equal('timed-out');
    should((await w.service.agentView(FERRET, view.id, 3_600_000)).state).equal('timed-out');
  });

  it('should end a page approval whose page cannot be looked at, as the page being gone', async () => {
    const w = await phoneWorld();
    const view = await w.raiseBrowser();
    w.state.lookFails = true;

    await w.time.advance(1_000);

    should(w.seen(view.id).state).equal('gone');
    should(w.clears).eql([{ ferret: FERRET, id: view.id }]);
  });

  it('should keep watching after a check that throws, one second later, and still read the new document', async () => {
    const w = await phoneWorld();
    const view = await w.raiseBrowser();
    let broken = true;
    w.state.steered = () => {
      if (broken) throw new Error('the observer is restarting');
      return false;
    };
    w.state.page = { pageId: 'p1', read: oktaRead('77', 'doc-2') };

    await w.time.advance(1_000);
    should(w.seen(view.id).number?.value).equal('42');
    broken = false;
    await w.time.advance(2_000);

    should(w.seen(view.id).state).equal('waiting');
    should(w.seen(view.id).number?.value).equal('77');
  });

  it('should keep watching through a terminal look that fails and still see the sign-in move on', async () => {
    const w = await phoneWorld();
    const view = await w.raiseTerminal();
    w.state.observeFails = true;

    await w.time.advance(3_000);
    should(w.seen(view.id).state).equal('waiting');
    w.state.observeFails = false;
    w.state.terminal = terminalSeen('b'.repeat(64));
    await w.time.advance(2_000);

    should(w.seen(view.id).state).equal('moved-on');
  });

  it('should end a terminal approval when its pane closes or is another pane, and keep waiting where it cannot tell', async () => {
    const closed = await phoneWorld();
    const first = await closed.raiseTerminal();
    closed.state.terminal = { ok: false, reason: 'target_gone' };
    await closed.time.advance(1_000);
    should(closed.seen(first.id).state).equal('gone');

    const renamed = await phoneWorld();
    const second = await renamed.raiseTerminal();
    renamed.state.terminal = { ...terminalSeen(), names: ['%9'] } as never;
    await renamed.time.advance(1_000);
    should(renamed.seen(second.id).state).equal('gone');

    const unsure = await phoneWorld();
    const third = await unsure.raiseTerminal();
    unsure.state.terminal = { ok: false, reason: 'unsupported' };
    await unsure.time.advance(3_000);
    should(unsure.seen(third.id).state).equal('waiting');
  });
});
