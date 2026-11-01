import { describe, it } from 'bun:test';
import should from 'should';
import {
  AgendaActionRequestSchema,
  type AgendaGate,
  AgendaItemSchema,
  agendaAnswerProblems,
} from '../../src/lib/agenda.ts';
import {
  GATE_NOT_YET_LABEL,
  gateAnswers,
  gateAskOptions,
  gateChoice,
  gateFollowupReference,
  gateNotYetLabel,
  gateReference,
  gateReopenOption,
  parseGateFollowupReference,
  parseGateReference,
} from '../../src/lib/agenda-gate.ts';
import { DAEMON_FEATURES, daemonFeatureList } from '../../src/lib/daemon-features.ts';

const AT = '2026-11-01T09:00:00.000Z';

const verify: AgendaGate = {
  cardId: 'F412',
  laneId: 'released',
  laneName: 'Released · to test',
  entry: 7,
  projectId: 'p-ferretry',
  projectName: 'Ferretry',
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};

const plan: AgendaGate = {
  ...verify,
  laneId: 'plan',
  laneName: 'Plan/Design',
  options: [{ id: 'ok', label: 'OK to build', outcome: 'next' }],
};

const layout = (gate: AgendaGate): string[] => gateAnswers(gate).map(each => `${each.direction}:${each.label}`);

const gateItem = (raisedBy: 'daemon' | 'agent', gate: AgendaGate = verify) => ({
  id: 'A3',
  source: 'task',
  sourceRef: gateReference(gate),
  subject: 'Try it: open the Board',
  why: 'F412 reached Released · to test.',
  waitingSince: AT,
  howToResolve: 'Choose Done or Not good.',
  kind: 'choice',
  title: 'Gate items',
  ask: { kind: 'multiple-choice', options: gateAskOptions(gate) },
  answers: gateAnswers(gate),
  task: { id: gate.cardId },
  gate,
  ...(raisedBy === 'daemon'
    ? { raisedBy, raisedBySession: null, raisedByName: null }
    : { raisedBy, raisedBySession: 's-1', raisedByName: null }),
});

describe('gate items', () => {
  describe('references', () => {
    it('round-trips a gate reference', () => {
      should(gateReference(verify)).equal('gate:F412:released:7');
      should(parseGateReference('gate:F412:released:7')).deepEqual({ cardId: 'F412', laneId: 'released', entry: 7 });
    });

    it('refuses anything that is not exactly a gate reference', () => {
      for (const bad of [
        null,
        undefined,
        '',
        'gate:',
        'gate:F412:released',
        'gate:F412:released:0',
        'gate:F412:released:-1',
        'gate:F412:released:7:extra',
        'gate:X412:released:7',
        'gate:F412::7',
        'gate:F412:released:1.5',
        'lanes:p-1:2',
        'gate-followup:F412:7',
      ]) {
        should(parseGateReference(bad)).be.undefined();
      }
    });

    it('round-trips a follow-up reference and keeps it apart from the gate', () => {
      should(gateFollowupReference({ cardId: 'F412', entry: 7 })).equal('gate-followup:F412:7');
      should(parseGateFollowupReference('gate-followup:F412:7')).deepEqual({ cardId: 'F412', entry: 7 });
      should(parseGateFollowupReference('gate:F412:released:7')).be.undefined();
      should(parseGateFollowupReference('gate-followup:F412')).be.undefined();
      should(parseGateFollowupReference('gate-followup:F412:0')).be.undefined();
    });
  });

  describe('answers', () => {
    it('puts the forward option on → and the reopen option on ←', () => {
      should(layout(verify)).deepEqual(['left:Not good', 'right:Done']);
      should(layout({ ...verify, options: [...verify.options].reverse() })).deepEqual(['left:Not good', 'right:Done']);
    });

    it('puts a third option on ↑', () => {
      const three: AgendaGate = {
        ...verify,
        options: [...verify.options, { id: 'later', label: 'Ship later', outcome: 'lane' }],
      };
      should(layout(three)).deepEqual(['left:Not good', 'up:Ship later', 'right:Done']);
    });

    it('fills the free directions when no option reopens', () => {
      const two: AgendaGate = {
        ...verify,
        options: [
          { id: 'merge', label: 'Merge', outcome: 'next' },
          { id: 'close', label: 'Close', outcome: 'close' },
        ],
      };
      should(layout(two)).deepEqual(['left:Close', 'right:Merge']);
    });

    it('gives a one-option gate a second answer, Not yet, on ←', () => {
      should(gateNotYetLabel(plan)).equal(GATE_NOT_YET_LABEL);
      should(gateNotYetLabel(verify)).be.undefined();
      should(gateAskOptions(plan)).deepEqual([{ label: 'Not yet' }, { label: 'OK to build' }]);
      should(layout(plan)).deepEqual(['left:Not yet', 'right:OK to build']);
    });

    it('never repeats a label when the one option is itself called Not yet', () => {
      const odd: AgendaGate = { ...plan, options: [{ id: 'wait', label: 'Not yet', outcome: 'next' }] };
      should(gateAskOptions(odd).map(option => option.label)).deepEqual(['Not now', 'Not yet']);
    });

    it('lists the ask options in swipe order, ← · ↑ · →, as a choice card lays them out', () => {
      should(gateAskOptions(verify).map(option => option.label)).deepEqual(['Not good', 'Done']);
      const three: AgendaGate = {
        ...verify,
        options: [...verify.options, { id: 'later', label: 'Ship later', outcome: 'lane' }],
      };
      should(gateAskOptions(three).map(option => option.label)).deepEqual(['Not good', 'Ship later', 'Done']);
    });

    it('lays a lone reopen option on ← and Not yet on →', () => {
      const back: AgendaGate = { ...verify, options: [{ id: 'redo', label: 'Redo', outcome: 'reopen-with-agenda' }] };
      should(layout(back)).deepEqual(['left:Redo', 'right:Not yet']);
    });

    it('answers fit the multiple-choice ask the item carries', () => {
      for (const gate of [verify, plan]) {
        should(
          agendaAnswerProblems(gateAnswers(gate), { kind: 'multiple-choice', options: gateAskOptions(gate) }),
        ).be.empty();
      }
    });
  });

  describe('choices', () => {
    it('reads a chosen label as the option, Not yet, or nothing', () => {
      should(gateChoice(verify, ' Done ')).deepEqual({ kind: 'option', option: verify.options[0] });
      should(gateChoice(plan, 'Not yet')).deepEqual({ kind: 'not-yet' });
      should(gateChoice(verify, 'Not yet')).deepEqual({ kind: 'unknown' });
      should(gateChoice(verify, 'Ship it')).deepEqual({ kind: 'unknown' });
    });

    it('finds the reopen option', () => {
      should(gateReopenOption(verify)?.id).equal('not-good');
      should(gateReopenOption(plan)).be.undefined();
    });
  });

  describe('the wire', () => {
    it('reads a daemon gate item', () => {
      should(AgendaItemSchema.safeParse(gateItem('daemon')).success).be.true();
      should(AgendaItemSchema.safeParse(gateItem('daemon', plan)).success).be.true();
    });

    it('refuses a gate on an item a ferret raised', () => {
      should(AgendaItemSchema.safeParse(gateItem('agent')).success).be.false();
    });

    it('refuses a gate with unknown keys, no options, or too many', () => {
      should(AgendaItemSchema.safeParse({ ...gateItem('daemon'), gate: { ...verify, extra: 1 } }).success).be.false();
      should(
        AgendaItemSchema.safeParse({ ...gateItem('daemon'), gate: { ...verify, options: [] } }).success,
      ).be.false();
      const four = [0, 1, 2, 3].map(index => ({ id: `o${index}`, label: `O${index}`, outcome: 'next' as const }));
      should(
        AgendaItemSchema.safeParse({ ...gateItem('daemon'), gate: { ...verify, options: four } }).success,
      ).be.false();
      should(
        AgendaItemSchema.safeParse({
          ...gateItem('daemon'),
          gate: { ...verify, options: [{ id: 'x', label: 'X', outcome: 'jump' }] },
        }).success,
      ).be.false();
    });

    it('never lets an agenda add carry a gate', () => {
      const add = {
        action: 'add',
        title: 'Try it',
        subject: 'Try it: open the Board',
        why: 'It shipped.',
        howToResolve: 'Choose.',
        kind: 'choice',
        ask: { kind: 'multiple-choice', options: [{ label: 'Done' }, { label: 'Not good' }] },
        premise: 'It shipped.',
        context: 'On the Mac.',
        gate: verify,
      };
      should(AgendaActionRequestSchema.safeParse(add).success).be.false();
    });

    it('names the health feature the app waits for', () => {
      should(DAEMON_FEATURES.boardGateItems).equal('board.gate-items.1');
      should(daemonFeatureList()).containEql('board.gate-items.1');
    });
  });
});
