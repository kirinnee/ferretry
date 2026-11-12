import { describe, it } from 'bun:test';
import type { WardenAction } from '../../daemon/lib/protocol.ts';
import type { Instant } from '@ferretry/std';
import should from 'should';
import {
  ferretAgendaView,
  ferretRunView,
  ferretStatusView,
  type WardenFocusCard,
  type WardenReadScope,
} from '../../daemon/lib/index.ts';
import { toWireAgenda, toWireStatus } from '../../daemon/lib/wire-map.ts';
import { lanes, PROJECT } from '../support/board.ts';
import { boardOf, cardView } from './board-fixtures.ts';
import { enabled, harness, type Harness, NOW, no, session, yes, type JevScript } from './sweep-harness.ts';

/**
 * Audit A fix 7: no word of Jev's own, and no word of the flag's detail, reaches a FERRET.
 *
 * Jev's output is closed questions — the reason is a static tree leaf, the nudge one of `NUDGE_MESSAGES`, a check's
 * `why` an enum — so this is not a rewrite of Jev. It PROVES it, with the one flag whose detail names ANOTHER session:
 * `peer_wait_unanswerable` (`detect.ts`) names the peer and the state it ended in, and that sentence is Jev's summary.
 * The peer here has a name and a state that appear nowhere else, so any of them in a ferret's view or in text typed
 * into its session came through Jev's input or output. Every act Jev can carry out is run; the owner's records are the
 * control (they still say what Jev said, and the detector's sentence is what Jev was shown).
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const PEER = 'zed-peer-91';
const PEER_STATE = 'stalled' as const;
/** Everything that must never reach a ferret: the peer, its state, and the detector's own sentence for whichever flag Jev acted on. */
const HOSTILE =
  /zed-peer-91|which is stalled|can never reply|awaiting a reply|tool command has run|quota reset time has passed|nothing moving for/u;

const scope: WardenReadScope = { mayRead: ferret => ferret === 's1' || ferret === 'q1' };

/** Whatever a ferret can be shown by the Warden for these sessions, as one string. */
async function ferretSees(subject: Harness): Promise<string> {
  const owner = toWireStatus(await subject.service.status());
  const status = ferretStatusView(owner, scope);
  const agenda = ferretAgendaView(toWireAgenda(await subject.service.agenda()), scope);
  const run = ferretRunView({ sweptAt: iso(NOW) as Instant, flags: owner.flags }, scope);
  return JSON.stringify({ status, agenda, run });
}

/** A ferret parked on a peer that has ended: the flag whose detail names the peer. */
const peerWaiter = (id: string, overrides: Parameters<typeof session>[0]['state'] = {}) =>
  session({
    id,
    status: 'running',
    state: {
      turn: 4,
      turnState: 'working',
      startedAt: iso(NOW - 86_400_000),
      lastSubprocessAt: iso(NOW - 5_000),
      subprocessSince: iso(NOW - 20 * MINUTE),
      subprocessKey: 'pid:40',
      waiting: { since: iso(NOW - 30 * MINUTE), peer: 'p9', peerName: PEER },
      ...overrides,
    },
  });
const peer = () => session({ id: 'p9', status: PEER_STATE, label: PEER });

/** The focus card a restarted or resumed ferret is handed, so the turn typed into it is delivered and read. */
const card: WardenFocusCard = { task: cardView({ title: 'Ship the thing' }), laneSet: lanes(PROJECT) };
const board = { read: async () => boardOf(), focusCard: async () => card };

const nudgedBefore: WardenAction = {
  at: iso(NOW - 60 * MINUTE),
  sessionId: 's1',
  action: 'nudge',
  outcome: 'done',
  by: 'warden',
  anomalyKind: 'peer_wait_unanswerable',
  detail: 'Nudged: it looked wedged.',
};

const allAlone = enabled({
  layers: { jev: true, llm: false },
  mayActAlone: { nudge: true, resume: true, restart: true, failover: true, stop: true, closeLeftovers: true },
});

const scenarios: readonly {
  readonly act: 'nudge' | 'stop' | 'restart' | 'resume';
  readonly fleet: () => ReturnType<typeof session>[];
  readonly guard: JevScript;
  readonly state?: { actions: WardenAction[] };
}[] = [
  {
    act: 'nudge',
    fleet: () => [peerWaiter('s1'), peer()],
    guard: {
      answers: { waiting_on_real: yes(0.97), wait_reasonable: no(0.97) },
      nudge: { id: 'peer_gone', confidence: 0.97 },
    },
  },
  {
    act: 'stop',
    fleet: () => [peerWaiter('s1', { lastTranscriptAt: iso(NOW - 12 * MINUTE) }), peer()],
    guard: { answers: { doing_new_things: no(0.99) } },
    state: { actions: [nudgedBefore] },
  },
  { act: 'restart', fleet: () => [peerWaiter('s1'), peer()], guard: { answers: { waiting_on_real: no(0.97) } } },
  {
    act: 'resume',
    fleet: () => [
      peerWaiter('s1'),
      peer(),
      session({ id: 'q1', status: 'rate_limited', state: { quota: { resetAt: NOW - 60_000 } } }),
    ],
    guard: { answers: { finished_on_purpose: no(0.97) } },
  },
];

describe('what reaches a ferret from Jev, whatever the act', () => {
  for (const scenario of scenarios) {
    it(`should type nothing of the peer or the flag's detail into the ferret on a Jev ${scenario.act}`, async () => {
      // Arrange
      const subject = harness({
        config: allAlone,
        fleet: scenario.fleet(),
        guard: [scenario.guard],
        board,
        ...(scenario.state === undefined ? {} : { state: scenario.state }),
      });

      // Act
      await subject.service.run({ force: false });

      // Assert: Jev WAS shown the detector's sentence (so this test can fail), and it acted.
      should(subject.judged.map(set => set.snapshot.summary).join('\n')).match(/zed-peer-91/u);
      const acted = subject.state().actions?.filter(entry => entry.by === 'jev' && entry.outcome === 'done') ?? [];
      should(acted.map(entry => entry.action)).containEql(scenario.act);
      // Everything typed into a ferret's session is a static message or a fixed sentence.
      should(subject.remedies.length).be.above(0);
      for (const remedy of subject.remedies) should(String(remedy.detail)).not.match(HOSTILE);
      // A restart or a resume is handed its card, and the reason given with it is a static leaf sentence.
      if (scenario.act === 'restart' || scenario.act === 'resume')
        should(subject.remedies.map(remedy => String(remedy.detail)).join('\n')).containEql('Your card:');
      // The ferret's views carry classifications and fixed sentences only.
      const seen = await ferretSees(subject);
      should(seen).not.match(HOSTILE);
      should(seen).containEql('"by":"jev"');
    });
  }

  it('should show the owner the same acts with Jev’s words, unchanged', async () => {
    // Arrange
    const subject = harness({
      config: allAlone,
      fleet: scenarios[0]!.fleet(),
      guard: [scenarios[0]!.guard],
    });

    // Act
    await subject.service.run({ force: false });

    // Assert: the control — the owner's record keeps Jev's sentence, and the flag keeps the detector's.
    should(subject.state().actions?.[0]?.detail).startWith('Jev nudged it');
    should(subject.state().actions?.[0]?.reason).be.a.String();
    should(JSON.stringify(toWireStatus(await subject.service.status()).flags)).match(/zed-peer-91/u);
  });
});
