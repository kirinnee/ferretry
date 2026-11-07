import { describe, it } from 'bun:test';
import should from 'should';
import { ferretStateOf, toWireAgenda, toWireBlessing, toWireFlag, toWireRun } from '../../daemon/lib/wire-map.ts';
import { wardenFleetSession, TurnOrdinals } from '../../daemon/fleet.ts';
import { ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';

describe('the words on the wire', () => {
  it('should restate a session status as one of the four ferret states', () => {
    // Arrange / Act / Assert
    should(ferretStateOf('thinking')).equal('working');
    should(ferretStateOf('awaiting_question')).equal('idle');
    should(ferretStateOf('failed')).equal('stopped');
    should(ferretStateOf('created')).equal('starting');
  });

  it('should name a flag by its ferret, not its session', () => {
    // Arrange
    const anomaly = { kind: 'unattended_question', sessionId: 'f1', status: 'awaiting_question', teammate: 'rae', detail: 'x' } as never;

    // Act
    const flag = toWireFlag(anomaly);

    // Assert
    should(flag).eql({ kind: 'unattended_question', ferret: 'f1', state: 'idle', name: 'rae', detail: 'x' });
  });

  it('should carry the blessing under the ferret', () => {
    // Arrange / Act
    const blessing = toWireBlessing({ sessionId: 'f1', kinds: ['unattended_question'], expiresAt: '2026-11-06T10:00:00.000Z', by: 'owner' } as never);

    // Assert
    should(blessing.ferret).equal('f1');
    should(blessing).not.have.property('sessionId');
  });

  it('should answer a run with flags and no session fields', () => {
    // Arrange / Act
    const run = toWireRun({ sweptAt: '2026-11-06T10:00:00.000Z', anomalies: [], message: 'nothing' } as never);

    // Assert
    should(run).eql({ sweptAt: '2026-11-06T10:00:00.000Z', flags: [], message: 'nothing' });
  });

  it('should restate the agenda sources in the contract words', () => {
    // Arrange / Act
    const view = toWireAgenda({
      generatedAt: '2026-11-06T10:00:00.000Z',
      outcome: 'items',
      boardsWithParseErrors: [],
      verdictCoverage: { limit: 40, truncated: false },
      items: [
        {
          sessionId: 'f1',
          id: 'i1',
          source: 'warden-anomaly',
          subject: 's',
          why: 'w',
          waitingSince: '2026-11-06T09:00:00.000Z',
          howToResolve: 'h',
          fromAnomaly: true,
        },
      ],
    } as never);

    // Assert
    should(view.items[0]?.source).equal('warden-flag');
    should(view.items[0]?.fromFlag).equal(true);
  });
});

describe('a ferret as the sweep reads it', () => {
  const ferret = (over: Record<string, unknown> = {}) =>
    ({ id: ferretId('f1'), name: 'rae', role: 'helper', harness: 'claude-code', runner: 'tmux', folder: '/w', state: 'working', createdAt: T0, stateAt: T0, parent: ferretId('lead'), ...over }) as never;

  it('should treat a helper as unattended work and a lead as a person at a terminal', () => {
    // Arrange / Act
    const helper = wardenFleetSession(ferret(), 1, undefined, 'd');
    const lead = wardenFleetSession(ferret({ parent: undefined, role: 'lead' }), 1, undefined, 'd');

    // Assert
    should(helper.config.mode).equal('auto');
    should(lead.config.mode).equal('interactive');
  });

  it('should shield a warden and everything it started from being flagged itself', () => {
    // Arrange / Act
    const warden = wardenFleetSession(ferret({ name: 'warden-00002a' }), 1, undefined, 'd');

    // Assert
    should(warden.config.wardenLineage).equal(true);
    should(warden.config.label).equal('fleet-warden');
  });

  it('should read an open question as waiting on someone, from when it was raised', () => {
    // Arrange / Act
    const waiting = wardenFleetSession(ferret({ state: 'idle' }), 1, undefined, 'd', '2026-11-06T08:00:00.000Z');

    // Assert
    should(waiting.state.status).equal('awaiting_question');
    should(waiting.state.lastActivityAt).equal('2026-11-06T08:00:00.000Z');
    should(waiting.state.turnState).equal('needs-input');
  });

  it('should count a new turn only when the conversation names a different one', () => {
    // Arrange
    const turns = new TurnOrdinals();

    // Act
    const first = turns.see('f1', 't1');
    const same = turns.see('f1', 't1');
    const next = turns.see('f1', 't2');

    // Assert
    should([first, same, next]).eql([1, 1, 2]);
  });
});
