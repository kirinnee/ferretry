import { describe, it } from 'bun:test';
import should from 'should';
import {
  detectStuckInput,
  mayHoldRetractedPointer,
  planStuckInput,
  STUCK_INPUT_HORIZON_MS,
  STUCK_INPUT_MS,
  type StuckInputSend,
  stuckInputCandidates,
  stuckInputNoticeLine,
  stuckSendOf,
  type WardenSessionView,
} from '../../daemon/lib/index.ts';

/**
 * A ferret idle with a message of ours typed and unsent in its box — the two of 2026-11-02, read from the
 * same facts the Warden reads: the session's state and its send ledger.
 */

const NOW = Date.parse('2026-11-02T15:10:00.000Z');
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const ferret = (
  id: string,
  state: Partial<WardenSessionView['state']> = {},
  config: Partial<WardenSessionView['config']> = {},
): WardenSessionView => ({
  config: { id, mode: 'auto', teammate: id, ...config },
  state: { status: 'running', turnState: 'your-turn', turnStateAt: iso(NOW - 21 * MINUTE), ...state },
  hasLiveMonitor: true,
});

/**
 * annabeth's turn pointer: typed into a stalled pane at 15:00:32, never seen to land, then drawn late — and
 * the send tracker, looking at the composer, says it is sitting there (`typedNotSent`).
 */
const pointer = (over: Partial<StuckInputSend> = {}): StuckInputSend => ({
  sendId: 'send-63',
  path: 'turn-file',
  fate: 'unaccounted',
  unaccountedReason: 'landing_unconfirmed',
  typedNotSent: true,
  acceptedAt: iso(NOW - 10 * MINUTE),
  attemptAt: iso(NOW - 10 * MINUTE),
  fateAt: iso(NOW - 10 * MINUTE + 25_000),
  fromName: 'tamika',
  ...over,
});

/** braelynn's: a lead's message typed mid-turn whose Enter was swallowed, left there when the turn ended. */
const swallowed = (over: Partial<StuckInputSend> = {}): StuckInputSend => ({
  sendId: 'send-lead',
  path: 'native-inline',
  fate: 'accepted',
  typedNotSent: true,
  acceptedAt: iso(NOW - 30 * MINUTE),
  attemptAt: iso(NOW - 30 * MINUTE),
  deadlineAt: iso(NOW + MINUTE),
  ...over,
});

describe('which ferrets are looked at', () => {
  it('should look at autonomous ferrets idle at their prompt long enough, and nothing else', () => {
    const fleet = [
      ferret('idle'),
      ferret('fresh', { turnStateAt: iso(NOW - MINUTE) }),
      ferret('working', { turnState: 'working' }),
      ferret('stopped', { status: 'stopped' }),
      ferret('owner', {}, { mode: 'interactive' }),
      ferret('warden', {}, { label: 'fleet-warden' }),
    ];

    // A working ferret is read too (B187 C3): its ledger decides, and the verified resubmit refuses a busy pane.
    should(stuckInputCandidates(fleet, NOW).map(view => view.config.id)).eql(['idle', 'working']);
  });
});

describe('when a send is stuck in the box', () => {
  it('should find an unconfirmed pointer the tracker sees sitting in the box', () => {
    should(stuckSendOf([pointer()], NOW)?.sendId).equal('send-63');
  });

  it('should find a message whose Enter was swallowed mid-turn, the turn having ended after it was typed', () => {
    should(stuckSendOf([swallowed()], NOW)?.sendId).equal('send-lead');
  });

  it('should still find one whose own long turn ended after the hold ceiling settled it (review finding)', () => {
    // Typed into a three-hour turn, settled unconfirmed at the two-hour ceiling, still in the box when that
    // same turn ends: the turn clock says "a turn ended since", the screen says it is still there.
    const timedOut = swallowed({
      fate: 'unaccounted',
      unaccountedReason: 'timeout',
      acceptedAt: iso(NOW - 3 * 60 * MINUTE),
      attemptAt: iso(NOW - 3 * 60 * MINUTE),
      fateAt: iso(NOW - 60 * MINUTE),
    });
    should(stuckSendOf([timedOut], NOW)?.sendId).equal('send-lead');
  });

  it('should not call a send stuck the tracker does not see in the box, whatever its fate says', () => {
    should(stuckSendOf([pointer({ typedNotSent: undefined })], NOW)).be.undefined();
    should(stuckSendOf([swallowed({ typedNotSent: false })], NOW)).be.undefined();
  });

  it('should leave alone a send too young, too old, settled, never typed, held, carried by a revive, or proven', () => {
    const young = iso(NOW - STUCK_INPUT_MS + 1_000);
    const cases: StuckInputSend[] = [
      pointer({ attemptAt: young, acceptedAt: young, fateAt: young }),
      pointer({
        attemptAt: iso(NOW - STUCK_INPUT_HORIZON_MS - MINUTE),
        acceptedAt: iso(NOW - STUCK_INPUT_HORIZON_MS - MINUTE),
      }),
      pointer({ fate: 'delivered' }),
      pointer({ fate: 'cancelled' }),
      pointer({ untyped: true }),
      pointer({ held: true }),
      pointer({ path: 'revive' }),
      swallowed({ typedNotSent: false }),
    ];
    for (const send of cases) should(stuckSendOf([send], NOW)).be.undefined();
  });

  it('should name the newest stuck send when there are several', () => {
    const older = pointer({ sendId: 'older', attemptAt: iso(NOW - 15 * MINUTE), acceptedAt: iso(NOW - 15 * MINUTE) });
    should(stuckSendOf([older, pointer()], NOW)?.sendId).equal('send-63');
  });
});

describe('the flag', () => {
  it('should say who, what, since when, and carry the send as its episode', () => {
    const [flag] = detectStuckInput([ferret('annabeth')], new Map([['annabeth', [pointer()]]]), NOW);

    should(flag).match({
      kind: 'input_stuck',
      sessionId: 'annabeth',
      teammate: 'annabeth',
      since: iso(NOW - 10 * MINUTE),
      idleMinutes: 10,
      subject: 'input:annabeth:send-63',
      sendId: 'send-63',
    });
    should(flag?.detail).match(/a message from tamika \(send send-63\) sits typed in its input box, not sent/);
  });

  it('should flag nothing for a ferret whose ledger could not be read', () => {
    should(detectStuckInput([ferret('annabeth')], new Map(), NOW)).be.empty();
  });
});

describe('what the Warden does about it', () => {
  const stuck = [{ sessionId: 'annabeth', sendId: 'send-63' }];

  it('should never notice a ferret whose press found its box empty (review finding)', () => {
    should(
      planStuckInput({ stuck, memory: { annabeth: { sendId: 'send-63', press: 'absent' } }, enabled: true }).steps,
    ).be.empty();
  });

  it('should press once for a new episode, then notice only if the press did not end it', () => {
    should(planStuckInput({ stuck, memory: {}, enabled: true }).steps).eql([
      { kind: 'press', sessionId: 'annabeth', sendId: 'send-63' },
    ]);
    should(
      planStuckInput({ stuck, memory: { annabeth: { sendId: 'send-63', press: 'submitted' } }, enabled: true }).steps,
    ).eql([{ kind: 'notice', sessionId: 'annabeth', sendId: 'send-63', press: 'submitted' }]);
    should(
      planStuckInput({ stuck, memory: { annabeth: { sendId: 'send-63', noticedAt: iso(NOW) } }, enabled: true }).steps,
    ).be.empty();
  });

  it('should treat a different stuck send as a new episode, and clear a ferret no longer flagged', () => {
    const plan = planStuckInput({
      stuck,
      memory: { annabeth: { sendId: 'send-62', noticedAt: iso(NOW) }, braelynn: { sendId: 'x', noticedAt: iso(NOW) } },
      enabled: true,
    });
    should(plan.steps).eql([{ kind: 'press', sessionId: 'annabeth', sendId: 'send-63' }]);
    should(plan.recovered).eql(['braelynn']);
  });

  it('should press and notice nothing while the Warden is off, but still clear recoveries', () => {
    const plan = planStuckInput({ stuck: [], memory: { braelynn: { sendId: 'x' } }, enabled: false });
    should(plan.steps).be.empty();
    should(plan.recovered).eql(['braelynn']);
  });

  it('should say on the notice what the Enter did', () => {
    const flag = { sessionId: 'annabeth', teammate: 'annabeth', since: iso(NOW) };
    should(stuckInputNoticeLine(flag, 'send-63', 'holding')).match(
      /^annabeth \(annabeth\): send send-63 stuck since .* Enter was pressed and did not take$/,
    );
    should(stuckInputNoticeLine(flag, 'send-63', 'refused')).match(/could not be pressed/);
    should(stuckInputNoticeLine(flag, 'send-63', 'submitted')).match(/Enter was pressed and it is still idle$/);
    should(stuckInputNoticeLine({ sessionId: 'annabeth' }, 'send-63', undefined)).match(
      /^annabeth: send send-63 stuck since unknown/,
    );
  });
});

describe('&B153: a delivered pointer the harness took back into the box', () => {
  /** marge's turn-007: typed, recorded, then rewound into the composer by Claude a second later. */
  const delivered = (over: Partial<StuckInputSend> = {}): StuckInputSend => ({
    sendId: 'turn-007',
    path: 'turn-file',
    fate: 'delivered',
    acceptedAt: iso(NOW - 3 * 60 * MINUTE),
    attemptAt: iso(NOW - 3 * 60 * MINUTE),
    fateAt: iso(NOW - 3 * 60 * MINUTE + 3_000),
    fromName: 'ryu',
    ...over,
  });

  it('should read the box only where the newest typed send is a delivered pointer inside the horizon', () => {
    should(mayHoldRetractedPointer([delivered()], NOW)).be.true();
    should(mayHoldRetractedPointer([delivered({ path: 'native-file' })], NOW)).be.true();
    should(
      mayHoldRetractedPointer([delivered(), delivered({ sendId: 'later', acceptedAt: iso(NOW - MINUTE) })], NOW),
    ).be.true();
    // Something typed after it: the conversation moved on.
    should(
      mayHoldRetractedPointer(
        [delivered(), delivered({ sendId: 'later', path: 'direct', acceptedAt: iso(NOW - MINUTE) })],
        NOW,
      ),
    ).be.false();
    // A later send that was never typed does not count.
    should(
      mayHoldRetractedPointer([delivered(), pointer({ untyped: true, acceptedAt: iso(NOW - MINUTE) })], NOW),
    ).be.true();
    should(mayHoldRetractedPointer([delivered({ fate: 'queued' })], NOW)).be.false();
    should(mayHoldRetractedPointer([delivered({ path: 'direct' })], NOW)).be.false();
    should(
      mayHoldRetractedPointer(
        [delivered({ acceptedAt: iso(NOW - STUCK_INPUT_HORIZON_MS - MINUTE), attemptAt: undefined })],
        NOW,
      ),
    ).be.false();
    should(mayHoldRetractedPointer([], NOW)).be.false();
  });

  it('should flag the send the box was read holding, anchored on the idle time rather than its old typing', () => {
    const [flag] = detectStuckInput(
      [ferret('marge')],
      new Map([['marge', [delivered()]]]),
      NOW,
      undefined,
      new Map([['marge', 'turn-007']]),
    );

    should(flag).match({
      kind: 'input_stuck',
      sessionId: 'marge',
      since: iso(NOW - 21 * MINUTE),
      idleMinutes: 21,
      subject: 'input:marge:turn-007',
      sendId: 'turn-007',
    });
  });

  it('should flag nothing when the box was not read holding it, and prefer a send the tracker sees stuck', () => {
    should(detectStuckInput([ferret('marge')], new Map([['marge', [delivered()]]]), NOW)).be.empty();
    should(
      detectStuckInput(
        [ferret('marge')],
        new Map([['marge', [delivered()]]]),
        NOW,
        undefined,
        new Map([['marge', 'gone']]),
      ),
    ).be.empty();
    const [flag] = detectStuckInput(
      [ferret('marge')],
      new Map([['marge', [delivered(), pointer()]]]),
      NOW,
      undefined,
      new Map([['marge', 'turn-007']]),
    );
    should(flag?.sendId).equal('send-63');
  });
});

describe('B187 a ferret that reads as working while a message of ours sits typed in its box', () => {
  it('B187 a working ferret with a fresh typedNotSent send is a candidate', () => {
    const working = ferret('nelly', { turnState: 'working', turnStateAt: iso(NOW - 50 * MINUTE) });
    const candidates = stuckInputCandidates([working], NOW);
    should(candidates.map(view => view.config.id)).eql(['nelly']);

    const found = detectStuckInput(candidates, new Map([['nelly', [pointer()]]]), NOW);
    should(found).have.length(1);
    should(found[0]).match({ kind: 'input_stuck', sessionId: 'nelly', sendId: 'send-63', idleMinutes: 10 });
    should(found[0]?.detail).match(/reads as working for 10m/);
    // The clock is the send's own typing, not the working turn's start: a long turn alone flags nothing.
    should(detectStuckInput(candidates, new Map([['nelly', [pointer({ typedNotSent: false })]]]), NOW)).be.empty();
    should(detectStuckInput(candidates, new Map([['nelly', []]]), NOW)).be.empty();
    should(
      detectStuckInput(candidates, new Map([['nelly', [pointer({ attemptAt: iso(NOW - MINUTE) })]]]), NOW),
    ).be.empty();
  });

  it('B187 a working ferret is never flagged for a delivered pointer the harness took back', () => {
    const working = ferret('nelly', { turnState: 'working', turnStateAt: iso(NOW - 50 * MINUTE) });
    const delivered = pointer({ fate: 'delivered', typedNotSent: undefined });

    should(
      detectStuckInput([working], new Map([['nelly', [delivered]]]), NOW, undefined, new Map([['nelly', 'send-63']])),
    ).be.empty();
  });
});
