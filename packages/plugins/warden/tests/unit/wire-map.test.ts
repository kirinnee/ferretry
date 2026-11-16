import { describe, it } from 'bun:test';
import should from 'should';
import {
  ferretStateOf,
  toWireAgenda,
  toWireBlessing,
  toWireFlag,
  toWireInvestigate,
  toWireLeave,
  toWireRun,
  toWireStatus,
  toWireVerdicts,
} from '../../daemon/lib/wire-map.ts';
import { harness } from './sweep-harness.ts';
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
    const anomaly = {
      kind: 'unattended_question',
      sessionId: 'f1',
      status: 'awaiting_question',
      teammate: 'rae',
      detail: 'x',
    } as never;

    // Act
    const flag = toWireFlag(anomaly);

    // Assert
    should(flag).eql({ kind: 'unattended_question', ferret: 'f1', state: 'idle', name: 'rae', detail: 'x' });
  });

  it('should carry the blessing under the ferret', () => {
    // Arrange / Act
    const blessing = toWireBlessing({
      sessionId: 'f1',
      kinds: ['unattended_question'],
      expiresAt: '2026-11-06T10:00:00.000Z',
      by: 'owner',
    } as never);

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
    ({
      id: ferretId('f1'),
      name: 'rae',
      role: 'helper',
      harness: 'claude-code',
      runner: 'tmux',
      folder: '/w',
      state: 'working',
      createdAt: T0,
      stateAt: T0,
      parent: ferretId('lead'),
      ...over,
    }) as never;

  it('should take the mode the ferret was started with, not guess it from its parent', () => {
    // Arrange / Act
    const topLevelAuto = wardenFleetSession(
      ferret({ parent: undefined, role: 'lead', mode: 'auto' }),
      1,
      undefined,
      'd',
    );
    const interactiveHelper = wardenFleetSession(ferret({ mode: 'interactive' }), 1, undefined, 'd');
    const autoHelper = wardenFleetSession(ferret({ mode: 'auto' }), 1, undefined, 'd');

    // Assert: a top-level --auto ferret is unattended; an interactive helper is a person's terminal
    should(topLevelAuto.config.mode).equal('auto');
    should(interactiveHelper.config.mode).equal('interactive');
    should(autoHelper.config.mode).equal('auto');
  });

  it('should read a ferret with no recorded mode as a person at a terminal (never acted on alone)', () => {
    // Arrange / Act
    const unknown = wardenFleetSession(ferret({ mode: undefined }), 1, undefined, 'd');

    // Assert
    should(unknown.config.mode).equal('interactive');
  });

  it('should shield a warden by its label, and what a warden started by its lineage stamp', () => {
    // Arrange / Act
    const warden = wardenFleetSession(ferret({ label: 'fleet-warden', mode: 'auto' }), 1, undefined, 'd');
    const child = wardenFleetSession(
      ferret({ name: 'rae', mode: 'auto', provenance: { v: 1, at: T0, origin: 'warden', wardenLineage: true } }),
      1,
      undefined,
      'd',
    );

    // Assert
    should(warden.config.label).equal('fleet-warden');
    should(child.config.wardenLineage).equal(true);
    should(child.config.label).be.undefined();
  });

  it('should not shield a ferret just because its name looks like a warden', () => {
    // Arrange / Act
    const lookalike = wardenFleetSession(ferret({ name: 'warden-0000aa', mode: 'auto' }), 1, undefined, 'd');

    // Assert
    should(lookalike.config.label).be.undefined();
    should(lookalike.config.wardenLineage).be.undefined();
    should(lookalike.config.mode).equal('auto');
  });

  it('should carry the label, the stamp of a ferret no warden started, and the model', () => {
    // Arrange / Act
    const session = wardenFleetSession(
      ferret({
        label: 'pack:alpha',
        model: 'opus',
        provenance: { v: 1, at: T0, origin: 'human', wardenLineage: false },
      }),
      1,
      undefined,
      'd',
    );

    // Assert
    should(session.config.label).equal('pack:alpha');
    should(session.config.wardenLineage).equal(false);
    should(session.config.model).equal('opus');
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

describe('the rest of the words on the wire', () => {
  it('should read a finished session as a stopped ferret', () => {
    should(ferretStateOf('completed')).equal('stopped');
    should(ferretStateOf('stopped')).equal('stopped');
  });

  it('should answer a status with no Jev checks without the field', async () => {
    const subject = harness({});
    const wire = toWireStatus({ ...(await subject.service.status()), jevChecks: undefined });
    should(wire).not.have.property('jevChecks');
    should(wire.flags).be.an.Array();
  });

  it('should name verdicts, an investigation and a leave by their ferrets', () => {
    const verdicts = toWireVerdicts([
      { at: '2026-11-06T10:00:00.000Z', targetSession: 'f1', teammate: 'rae', verdict: 'nudged', reportPath: 'r.md' },
    ] as never);
    should(verdicts).eql([
      { at: '2026-11-06T10:00:00.000Z', target: 'f1', name: 'rae', verdict: 'nudged', reportPath: 'r.md' },
    ]);
    should(
      toWireInvestigate({ sessionId: 'f1', state: 'running', wardenSession: 'w1', message: 'on it' } as never),
    ).eql({
      ferret: 'f1',
      state: 'running',
      warden: 'w1',
      message: 'on it',
    });
    const leave = toWireLeave({
      blessing: { sessionId: 'f1', kinds: ['unattended_question'], expiresAt: '2026-11-06T10:00:00.000Z', by: 'owner' },
      message: 'left alone',
    } as never);
    should(leave.blessing.ferret).equal('f1');
    should(leave.message).equal('left alone');
  });

  it('should carry the warden that judged an agenda item under its ferret name', () => {
    const view = toWireAgenda({
      generatedAt: '2026-11-06T10:00:00.000Z',
      outcome: 'items',
      boardsWithParseErrors: [],
      verdictCoverage: { limit: 40, truncated: false },
      items: [
        {
          sessionId: 'f1',
          id: 'i1',
          source: 'question',
          subject: 's',
          why: 'w',
          waitingSince: '2026-11-06T09:00:00.000Z',
          howToResolve: 'h',
          sessionStatus: 'thinking',
          judgement: {
            state: 'judged',
            reason: 'fine',
            judgedBy: { wardenSessionId: 'w1' },
          },
        },
        {
          sessionId: 'f2',
          id: 'i2',
          source: 'task',
          subject: 's',
          why: 'w',
          waitingSince: '2026-11-06T09:00:00.000Z',
          howToResolve: 'h',
          judgement: { state: 'judged', reason: 'fine' },
        },
      ],
    } as never);
    should(view.items[0]?.ferretState).equal('working');
    should(view.items[0]?.judgement?.judgedBy).eql({ warden: 'w1' });
    should(view.items[1]?.judgement).not.have.property('judgedBy');
    should(view.items[1]?.source).equal('card');
  });
});
