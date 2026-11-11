import { describe, it } from 'bun:test';
import should from 'should';
import {
  COMPACTION_GLYPHS,
  COMPACTION_SHAPES,
  COMPACTION_TEXTS,
  NOT_COMPACTION_LINES,
} from '../../../../../../std/tests/support/compaction-shapes.ts';
import { parseSessionId } from '../../../../daemon/seams/ferret-id.ts';
import { routeSend, type SendPaneObservation, type SendTarget } from '../../../../daemon/delivery/lib/index.ts';

/**
 * &B188: the shared table of every Claude compaction status shape (`@ferretry/std`'s `tests/support/compaction-shapes.ts`),
 * run through the routing it feeds. The terminals plugin's pane readers and Ferrets' `paneCompaction` run the same
 * table in their own tests; the runner-world integration test carries a frame all the way to this routing. A parked
 * session's send once bypassed the busy override on `✢ Compacting conversation... (esc to interrupt)`.
 */

const ID = parseSessionId('session-1');
const target = (overrides: Partial<SendTarget> = {}): SendTarget => ({
  id: ID,
  status: 'running',
  mode: 'auto',
  turn: 3,
  ...overrides,
});

/** What the runner's observation says of a frame the readers took for a compaction: work, no composer to type into. */
const COMPACTING: SendPaneObservation = {
  alive: true,
  dead: false,
  promptReady: false,
  activeWork: true,
  compacting: true,
};

/** What it says of a line that only mentions compaction: an idle composer, no work. */
const QUIET: SendPaneObservation = {
  alive: true,
  dead: false,
  promptReady: true,
  activeWork: false,
  compacting: false,
};

describe('B188 the shared compaction shape table, routed', () => {
  it('covers every spinner tick on every status text', () => {
    should(COMPACTION_SHAPES).have.length(COMPACTION_GLYPHS.length * COMPACTION_TEXTS.length);
  });

  for (const shape of COMPACTION_SHAPES)
    it(`routes "${shape.line}" busy under every stored status (${shape.source})`, () => {
      for (const status of ['awaiting_user', 'interrupted', 'waiting', 'rate_limited', 'running'] as const) {
        should(routeSend(target({ status }), COMPACTING)).equal('busy');
        should(routeSend(target({ status, promptReady: true }), COMPACTING)).equal('busy');
      }
    });
});

describe('B188 lines that only mention compaction', () => {
  // The readers' own tests prove each line in the table reads as no compaction (`compacting: false`); what the routing
  // owes is that such a reading never holds a parked session back.
  it(`does not hold back a parked session when ${NOT_COMPACTION_LINES.length} compaction-like lines read as no compaction`, () => {
    for (const status of ['awaiting_user', 'interrupted'] as const)
      should(routeSend(target({ status }), QUIET)).equal('idle');
  });
});
