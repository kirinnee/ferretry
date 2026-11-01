import { describe, it } from 'bun:test';
import should from 'should';
import { gateFollowupReference, gateReference } from '../../src/lib/agenda-gate.ts';
import {
  DAEMON_SOURCE_REF_PREFIXES,
  harnessQuestionRef,
  harnessToolUseId,
  isDaemonSourceRef,
  isHarnessQuestionId,
} from '../../src/lib/agenda-source-refs.ts';
import { laneProposalReference } from '../../src/lib/board-lanes.ts';

describe('reserved source references (docs/agenda.md § Reserved sourceRefs)', () => {
  it('knows every daemon producer’s grammar', () => {
    should(DAEMON_SOURCE_REF_PREFIXES).eql([
      'lanes:',
      'gate:',
      'gate-followup:',
      'warden:',
      'warden-orphan:',
      'handover:',
      'budget:',
      'prompt:',
      'question:',
    ]);
    for (const ref of [
      laneProposalReference('11111111-1111-4111-8111-111111111111', 2),
      gateReference({ cardId: 'F412', laneId: 'released', entry: 7 }),
      gateFollowupReference({ cardId: 'F412', entry: 7 }),
      'warden:ask:stuck',
      'warden-orphan:F1',
      'handover:req-1',
      'budget:claude:week:2026-11-08T00:00:00.000Z',
      'prompt:dialog-1',
      'question:toolu_1',
    ]) {
      should(isDaemonSourceRef(ref)).be.true();
    }
    should(isDaemonSourceRef(null)).be.false();
    should(isDaemonSourceRef('toolu_01T4KnfY1in2GTL7P9wUmRtt')).be.false();
  });

  it('refuses a harness question id in any daemon grammar, empty, or too long once namespaced', () => {
    for (const prefix of DAEMON_SOURCE_REF_PREFIXES) should(isHarnessQuestionId(`${prefix}x`)).be.false();
    should(isHarnessQuestionId('lanes:11111111-1111-4111-8111-111111111111:2')).be.false();
    should(isHarnessQuestionId('')).be.false();
    should(isHarnessQuestionId('   ')).be.false();
    should(isHarnessQuestionId('x'.repeat(504))).be.false();
    should(isHarnessQuestionId('x'.repeat(503))).be.true();
  });

  it('takes the ids real harnesses write, a colon in one included', () => {
    for (const id of [
      'toolu_01T4KnfY1in2GTL7P9wUmRtt',
      'toolu_1',
      'call_resp',
      'call_abc123',
      'question-codex',
      'tool-1',
      'tool 10',
      'functions.Name:0',
    ]) {
      should(isHarnessQuestionId(id)).be.true();
    }
  });

  it('namespaces a harness question and reads its tool id back', () => {
    should(harnessQuestionRef('functions.Name:0')).equal('question:functions.Name:0');
    should(harnessToolUseId('question:functions.Name:0')).equal('functions.Name:0');
    should(harnessToolUseId('toolu_1')).equal('toolu_1');
  });
});
