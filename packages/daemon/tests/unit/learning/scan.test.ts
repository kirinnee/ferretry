import { describe, it } from 'bun:test';
import should from 'should';
import {
  batchesOf,
  estimateScan,
  SCAN_OUTPUT_TOKENS,
  SCAN_PROMPT_TOKENS,
  type ScanCandidate,
  type ScanRecord,
  scanProgress,
  selectScanSessions,
} from '../../../src/lib/learning/index.ts';

/**
 * The explicit scan: which ferrets it reads, what it would cost before anything is spent, and how
 * far it got. All pure, so every scope kind and every edge is a table row here.
 */

const MINER = 'ferretry-learning';

const candidate = (overrides: Partial<ScanCandidate> & { readonly sessionId: string }): ScanCandidate => ({
  cwd: '/work/ferretry',
  createdAt: '2026-08-01T10:00:00.000Z',
  hasTranscript: true,
  passive: false,
  ...overrides,
});

const FERRETS: readonly ScanCandidate[] = [
  candidate({ sessionId: 'late', createdAt: '2026-08-03T10:00:00.000Z', cwd: '/work/kteam' }),
  candidate({ sessionId: 'early', createdAt: '2026-08-01T10:00:00.000Z', cwd: '/work/ferretry/packages/cli' }),
  candidate({ sessionId: 'passive', createdAt: '2026-08-02T10:00:00.000Z', passive: true }),
  candidate({ sessionId: 'blind', createdAt: '2026-08-02T11:00:00.000Z', hasTranscript: false }),
  candidate({ sessionId: 'sibling', createdAt: '2026-08-02T12:00:00.000Z', cwd: '/work/ferretry-old' }),
  candidate({ sessionId: 'miner', createdAt: '2026-08-02T13:00:00.000Z', label: MINER }),
];

describe('the lesson scan', () => {
  describe('selectScanSessions', () => {
    it('should read every ferret not instructed to learn, oldest first, never a miner', () => {
      // Arrange / Act
      const selected = selectScanSessions(FERRETS, { kind: 'not-passive' }, MINER);

      // Assert
      should(selected.sessionIds).deepEqual(['early', 'sibling', 'late']);
      // In scope but unreadable: counted, not read.
      should(selected.skipped).equal(1);
    });

    it('should read the ferrets started inside a range, both ends included', () => {
      // Arrange / Act
      const selected = selectScanSessions(
        FERRETS,
        { kind: 'range', from: '2026-08-02T10:00:00.000Z', to: '2026-08-02T12:00:00.000Z' },
        MINER,
      );

      // Assert
      should(selected).deepEqual({ sessionIds: ['passive', 'sibling'], skipped: 1 });
    });

    it('should read the ferrets working in a project or below it, and not a sibling that shares a prefix', () => {
      // Arrange / Act
      const selected = selectScanSessions(FERRETS, { kind: 'projects', projects: ['/work/ferretry/'] }, MINER);

      // Assert
      should(selected).deepEqual({ sessionIds: ['early', 'passive'], skipped: 1 });
    });

    it('should read exactly the ferrets named, and still never a miner', () => {
      // Arrange / Act
      const selected = selectScanSessions(
        FERRETS,
        { kind: 'sessions', sessionIds: ['late', 'miner', 'blind', 'nobody'] },
        MINER,
      );

      // Assert
      should(selected).deepEqual({ sessionIds: ['late'], skipped: 1 });
    });
  });

  describe('estimateScan', () => {
    it('should cost nothing when nothing is read', () => {
      // Arrange / Act / Assert
      should(estimateScan([], 20)).deepEqual({ miners: 0, inputTokens: 0, outputTokens: 0 });
    });

    it('should count every digest once and each miner its prompt and answer', () => {
      // Arrange / Act
      const cost = estimateScan([400, 801, 3], 2);

      // Assert — 1204 characters is 301 tokens, over two miners.
      should(cost).deepEqual({
        miners: 2,
        inputTokens: 301 + 2 * SCAN_PROMPT_TOKENS,
        outputTokens: 2 * SCAN_OUTPUT_TOKENS,
      });
    });

    it('should treat a batch size below one as one ferret per miner', () => {
      // Arrange / Act / Assert
      should(estimateScan([4, 4], 0).miners).equal(2);
    });
  });

  describe('batchesOf', () => {
    it('should split ids into batches of at most the size, in order', () => {
      // Arrange / Act / Assert
      should(batchesOf(['a', 'b', 'c', 'd', 'e'], 2)).deepEqual([['a', 'b'], ['c', 'd'], ['e']]);
      should(batchesOf([], 2)).deepEqual([]);
      should(batchesOf(['a', 'b'], 0)).deepEqual([['a'], ['b']]);
    });
  });

  describe('scanProgress', () => {
    const record: ScanRecord = {
      runId: 'scan-1',
      state: 'running',
      sessionIds: ['a', 'b'],
      batches: [{ minerSessionId: 'm1', sessionIds: ['a', 'b'] }],
      startedAt: '2026-08-01T10:00:00.000Z',
      done: 0,
      added: 0,
      merged: 0,
    };

    it('should show a running scan without the fields it has not earned', () => {
      // Arrange / Act / Assert
      should(scanProgress(record)).deepEqual({
        runId: 'scan-1',
        state: 'running',
        total: 2,
        done: 0,
        startedAt: '2026-08-01T10:00:00.000Z',
        added: 0,
        merged: 0,
      });
    });

    it('should show a finished scan with its end and message, never more done than total', () => {
      // Arrange / Act
      const progress = scanProgress({
        ...record,
        state: 'finished',
        done: 5,
        added: 2,
        merged: 1,
        finishedAt: '2026-08-01T11:00:00.000Z',
        message: 'done',
      });

      // Assert
      should(progress).deepEqual({
        runId: 'scan-1',
        state: 'finished',
        total: 2,
        done: 2,
        startedAt: '2026-08-01T10:00:00.000Z',
        finishedAt: '2026-08-01T11:00:00.000Z',
        added: 2,
        merged: 1,
        message: 'done',
      });
    });
  });
});
