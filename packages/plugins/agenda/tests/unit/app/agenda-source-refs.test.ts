import { describe, it } from 'bun:test';
import should from 'should';
import {
  DAEMON_SOURCE_REF_PREFIXES,
  harnessQuestionRef,
  harnessToolUseId,
  isDaemonSourceRef,
  isHarnessQuestionId,
} from '../../../app/lib/agenda-source-refs.ts';

describe('reserved source references (docs/agenda.md § Reserved sourceRefs)', () => {
  it('should know every daemon producer’s grammar', () => {
    // Arrange
    const written = [
      'lanes:11111111-1111-4111-8111-111111111111:2',
      'gate:F412:released:7',
      'gate-followup:F412:7',
      'card-agenda:F412',
      'warden:ask:stuck',
      'warden-orphan:F1',
      'handover:req-1',
      'budget:claude:week:2026-11-08T00:00:00.000Z',
      'prompt:dialog-1',
      'question:toolu_1',
    ];

    // Act / Assert
    should(DAEMON_SOURCE_REF_PREFIXES).eql([
      'lanes:',
      'gate:',
      'gate-followup:',
      'card-agenda:',
      'warden:',
      'warden-orphan:',
      'handover:',
      'budget:',
      'prompt:',
      'question:',
    ]);
    for (const ref of written) should(isDaemonSourceRef(ref)).be.true();
  });

  it('should not take a missing reference or a provider’s own id for a daemon reference', () => {
    // Act / Assert
    should(isDaemonSourceRef(null)).be.false();
    should(isDaemonSourceRef(undefined)).be.false();
    should(isDaemonSourceRef('toolu_01T4KnfY1in2GTL7P9wUmRtt')).be.false();
  });

  it('should refuse a harness question id in any daemon grammar, empty, or too long once namespaced', () => {
    // Act / Assert
    for (const prefix of DAEMON_SOURCE_REF_PREFIXES) should(isHarnessQuestionId(`${prefix}x`)).be.false();
    should(isHarnessQuestionId('')).be.false();
    should(isHarnessQuestionId('   ')).be.false();
    should(isHarnessQuestionId('x'.repeat(504))).be.false();
    should(isHarnessQuestionId('x'.repeat(503))).be.true();
  });

  it('should take the ids real harnesses write, a colon in one included', () => {
    // Act / Assert
    for (const id of ['toolu_01T4KnfY1in2GTL7P9wUmRtt', 'call_abc123', 'tool 10', 'functions.Name:0']) {
      should(isHarnessQuestionId(id)).be.true();
    }
  });

  it('should namespace a harness question and read its tool id back', () => {
    // Act / Assert
    should(harnessQuestionRef('functions.Name:0')).equal('question:functions.Name:0');
    should(harnessToolUseId('question:functions.Name:0')).equal('functions.Name:0');
    should(harnessToolUseId('toolu_1')).equal('toolu_1');
  });
});
