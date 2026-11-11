import { describe, it } from 'bun:test';
import should from 'should';
import { paneActiveWork, paneCompaction, paneShowsCompacting, promptIsReady } from '../../../../src/lib/index.ts';
import { routeSend, type SendPaneObservation, type SendTarget } from '../../../../src/lib/session/send/index.ts';
import { parseSessionId } from '../../../../src/lib/index.ts';
import {
  COMPACTION_GLYPHS,
  COMPACTION_SHAPES,
  COMPACTION_TEXTS,
  compactionFrame,
  NOT_COMPACTION_LINES,
} from '../../../support/compaction-shapes.ts';

/**
 * &B188 round 2: one table of every Claude compaction status shape, run through both pane readers and the routing
 * they feed. `✢ Compacting conversation... (esc to interrupt)` once slipped between the readers: `paneCompaction`
 * saw it, `paneShowsCompacting` did not, and a parked session's send was typed into the compacting composer.
 */

const ID = parseSessionId('session-1');
const target = (overrides: Partial<SendTarget> = {}): SendTarget => ({
  id: ID,
  status: 'running',
  mode: 'auto',
  turn: 3,
  ...overrides,
});

/** The observation the tmux adapter builds from a frame, from the same readers. */
const observe = (frame: string): SendPaneObservation => ({
  alive: true,
  dead: false,
  promptReady: promptIsReady(frame),
  activeWork: paneActiveWork(frame) !== undefined,
  compacting: paneShowsCompacting(frame),
});

describe('B188 the shared compaction shape table', () => {
  it('covers every spinner tick on every status text', () => {
    should(COMPACTION_SHAPES).have.length(COMPACTION_GLYPHS.length * COMPACTION_TEXTS.length);
  });

  for (const shape of COMPACTION_SHAPES) {
    it(`reads "${shape.line}" as a compaction in both readers (${shape.source})`, () => {
      const frame = compactionFrame(shape.line);

      should(paneShowsCompacting(frame)).be.true();
      should(paneCompaction(frame)).not.be.undefined();
      should(paneActiveWork(frame)).equal('status');
      should(promptIsReady(frame)).be.false();
    });

    it(`routes "${shape.line}" busy under every stored status`, () => {
      const pane = observe(compactionFrame(shape.line));

      for (const status of ['awaiting_user', 'interrupted', 'waiting', 'rate_limited', 'running'] as const) {
        should(routeSend(target({ status }), pane)).equal('busy');
        should(routeSend(target({ status, promptReady: true }), pane)).equal('busy');
      }
    });
  }

  it('reads a carriage-return framed shape the same', () => {
    for (const shape of COMPACTION_SHAPES) {
      const frame = compactionFrame(shape.line).replaceAll('\n', '\r\n');

      should(paneShowsCompacting(frame)).be.true();
      should(paneCompaction(frame)).not.be.undefined();
    }
  });
});

describe('B188 lines that only mention compaction', () => {
  for (const line of NOT_COMPACTION_LINES) {
    it(`does not read "${line}" as a compaction, and a parked session still routes idle`, () => {
      const frame = compactionFrame(line);
      const pane = observe(frame);

      should(paneShowsCompacting(frame)).be.false();
      should(paneCompaction(frame)).be.undefined();
      should(pane.compacting).be.false();
      for (const status of ['awaiting_user', 'interrupted'] as const)
        should(routeSend(target({ status }), pane)).equal('idle');
    });
  }
});
