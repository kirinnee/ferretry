import { describe, it } from 'bun:test';
import should from 'should';
import {
  DAEMON_SOURCE_REF_PREFIXES,
  isDaemonSourceRef,
  isHarnessQuestionId,
} from '../../src/lib/agenda-source-refs.ts';
import { gateFollowupReference, gateReference } from '../../src/lib/agenda-gate.ts';
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
    ]) {
      should(isDaemonSourceRef(ref)).be.true();
    }
    should(isDaemonSourceRef(null)).be.false();
    should(isDaemonSourceRef('toolu_01T4KnfY1in2GTL7P9wUmRtt')).be.false();
  });

  it('refuses a harness question id in any daemon grammar, or with a colon, empty or too long', () => {
    for (const prefix of DAEMON_SOURCE_REF_PREFIXES) should(isHarnessQuestionId(`${prefix}x`)).be.false();
    should(isHarnessQuestionId('lanes:11111111-1111-4111-8111-111111111111:2')).be.false();
    should(isHarnessQuestionId('anything:else')).be.false();
    should(isHarnessQuestionId('')).be.false();
    should(isHarnessQuestionId('   ')).be.false();
    should(isHarnessQuestionId('x'.repeat(513))).be.false();
  });

  it('takes the ids real harnesses write', () => {
    for (const id of [
      'toolu_01T4KnfY1in2GTL7P9wUmRtt',
      'toolu_1',
      'call_resp',
      'call_abc123',
      'question-codex',
      'tool-1',
      'tool 10',
    ]) {
      should(isHarnessQuestionId(id)).be.true();
    }
  });
});
