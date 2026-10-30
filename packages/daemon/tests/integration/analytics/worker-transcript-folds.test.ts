/**
 * THE ANALYTICS FOLD ON A WORKER THREAD CONCLUDES EXACTLY WHAT THE EVENT LOOP WOULD.
 *
 * Ingestion reads a finished session's whole transcript and folds every event; on the event loop that was
 * the largest block left once parsing yielded. It now runs on a worker, and these prove two things: the
 * real worker's fold of a real transcript equals the event loop's fold of the same file, and a worker
 * that fails, stalls or answers wrongly is refused and replaced rather than trusted or waited on forever.
 */
import { afterAll, describe, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalyticsModelAliasGroup } from '@ferretry/protocol';
import should from 'should';
import {
  type FoldWorker,
  readAnalyticsTranscriptEvidence,
  type TranscriptFoldRequest,
  type TranscriptFoldResponse,
  WorkerTranscriptFolds,
} from '../../../src/adapters/analytics/index.ts';
import { NodeTranscriptSource } from '../../../src/adapters/transcript/file-source.ts';
import { foldAnalyticsTranscript } from '../../../src/lib/analytics/usage-fold.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { waitFor } from '../support/wait-for.ts';

const FIXTURES = join(import.meta.dir, '../../fixtures/transcript');
const ALIASES: readonly AnalyticsModelAliasGroup[] = [{ modelId: 'claude-opus-4-1', aliases: ['opus'] }];

afterAll(async () => {
  await cleanupTempDirectories();
});

/** What the event loop concludes about `file`: the very read and fold ingestion used to run here. */
async function foldedHere(file: string, harness: 'claude' | 'codex') {
  const source = new NodeTranscriptSource(
    harness === 'claude' ? new ClaudeTranscriptParser() : new CodexTranscriptParser(),
  );
  return foldAnalyticsTranscript(await readAnalyticsTranscriptEvidence(source, file, 'fold-session', harness), ALIASES);
}

/** A worker a test drives: it records what it was sent and answers however the test says. */
class ScriptedWorker implements FoldWorker {
  onmessage: ((event: MessageEvent<TranscriptFoldResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: TranscriptFoldRequest[] = [];
  terminated = false;

  constructor(private readonly answer: (request: TranscriptFoldRequest, worker: ScriptedWorker) => void) {}

  postMessage(request: TranscriptFoldRequest): void {
    this.sent.push(request);
    queueMicrotask(() => this.answer(request, this));
  }

  reply(response: TranscriptFoldResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<TranscriptFoldResponse>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const UNREADABLE = foldAnalyticsTranscript({ kind: 'unreadable' });

describe('WorkerTranscriptFolds with the real worker', () => {
  for (const [fixture, harness] of [
    ['claude.jsonl', 'claude'],
    ['codex.jsonl', 'codex'],
    ['claude-fast-mode.jsonl', 'claude'],
  ] as const) {
    it(`should fold ${fixture} on the worker exactly as the event loop folds it`, async () => {
      // Arrange
      const file = join(FIXTURES, fixture);
      const folds = new WorkerTranscriptFolds(async () => file);

      // Act
      const onWorker = await folds.foldFor('fold-session', harness, ALIASES);
      folds.close();

      // Assert
      should(onWorker).deepEqual(await foldedHere(file, harness));
    });
  }

  it('should fold several transcripts at once on one thread, each to its own answer', async () => {
    // Arrange
    const claude = join(FIXTURES, 'claude.jsonl');
    const codex = join(FIXTURES, 'codex.jsonl');
    const folds = new WorkerTranscriptFolds(async id => (id === 'a' ? claude : codex));

    // Act
    const idle = folds.inFlight;
    const asked = Promise.all([folds.foldFor('a', 'claude', ALIASES), folds.foldFor('b', 'codex', ALIASES)]);
    await new Promise<void>(resolve => setImmediate(resolve));
    const held = folds.inFlight;
    const [first, second] = await asked;
    const settled = folds.inFlight;
    folds.close();

    // Assert — the queue depth a profile samples counts exactly the folds the thread holds.
    should([idle, held, settled]).deepEqual([0, 2, 0]);
    should(first).deepEqual(await foldedHere(claude, 'claude'));
    should(second).deepEqual(await foldedHere(codex, 'codex'));
  });

  it('should refuse a transcript too long to prove complete without reading it, as the event loop does', async () => {
    // Arrange — sparse, so the size is real and nothing is written.
    const directory = await tempDirectory('fyd-fold-oversize-');
    const file = join(directory, 'huge.jsonl');
    await mkdir(directory, { recursive: true });
    await writeFile(file, '');
    const { truncate } = await import('node:fs/promises');
    await truncate(file, 40 * 1024 * 1024);
    const folds = new WorkerTranscriptFolds(async () => file);

    // Act
    const folded = await folds.foldFor('huge', 'claude', ALIASES);
    folds.close();

    // Assert
    should(folded).deepEqual(await foldedHere(file, 'claude'));
    should(folded.usage).deepEqual({ kind: 'refused', reason: 'transcript_damaged' });
  });

  it('should answer an unresolved session without starting a worker at all', async () => {
    // Arrange
    let spawned = 0;
    const folds = new WorkerTranscriptFolds(async () => undefined, {
      spawn: () => {
        spawned += 1;
        return new ScriptedWorker(() => undefined);
      },
    });

    // Act
    const folded = await folds.foldFor('nowhere', 'claude', ALIASES);

    // Assert
    should(folded).deepEqual(foldAnalyticsTranscript({ kind: 'unresolved' }, ALIASES));
    should(spawned).equal(0);
  });
});

describe('WorkerTranscriptFolds with a worker that misbehaves', () => {
  it('should refuse a fold the worker could not make, and keep the worker', async () => {
    // Arrange
    const workers: ScriptedWorker[] = [];
    const folds = new WorkerTranscriptFolds(async () => '/t.jsonl', {
      spawn: () => {
        const worker = new ScriptedWorker((request, self) => self.reply({ id: request.id, error: 'disk went away' }));
        workers.push(worker);
        return worker;
      },
    });

    // Act
    const refused = await folds.foldFor('s', 'claude', ALIASES).catch((error: Error) => error.message);
    await folds.foldFor('s', 'claude', ALIASES).catch(() => undefined);

    // Assert
    should(refused).equal('disk went away');
    should(workers).have.length(1);
    should(workers[0]?.terminated).be.false();
  });

  it('should end a worker that errors, refuse what waited on it, and start a fresh one next time', async () => {
    // Arrange
    const workers: ScriptedWorker[] = [];
    let crash = true;
    const folds = new WorkerTranscriptFolds(async () => '/t.jsonl', {
      spawn: () => {
        const worker = new ScriptedWorker((request, self) => {
          if (crash) self.onerror?.({ message: 'thread died' } as ErrorEvent);
          else self.reply({ id: request.id, fold: UNREADABLE });
        });
        workers.push(worker);
        return worker;
      },
    });

    // Act
    const failed = await folds.foldFor('s', 'claude', ALIASES).catch((error: Error) => error.message);
    crash = false;
    const recovered = await folds.foldFor('s', 'claude', ALIASES);
    folds.close();

    // Assert
    should(failed).equal('the analytics worker failed: thread died');
    should(recovered).deepEqual(UNREADABLE);
    should(workers).have.length(2);
    should(workers[0]?.terminated).be.true();
  });

  it('should give up on a worker that does not answer in time, and replace it', async () => {
    // Arrange
    const workers: ScriptedWorker[] = [];
    const folds = new WorkerTranscriptFolds(async () => '/t.jsonl', {
      timeoutMs: 5,
      spawn: () => {
        const worker = new ScriptedWorker(() => undefined);
        workers.push(worker);
        return worker;
      },
    });

    // Act
    const stalled = await folds.foldFor('s', 'claude', ALIASES).catch((error: Error) => error.message);

    // Assert
    should(stalled).equal('the analytics worker did not fold /t.jsonl within 5 ms');
    should(workers[0]?.terminated).be.true();
  });

  it('should end an idle worker, ignore answers it was not waiting for, and refuse everything on close', async () => {
    // Arrange
    const workers: ScriptedWorker[] = [];
    let hold = false;
    const folds = new WorkerTranscriptFolds(async () => '/t.jsonl', {
      idleMs: 5,
      spawn: () => {
        const worker = new ScriptedWorker((request, self) => {
          self.reply({ probe: true });
          self.reply({ id: request.id + 1_000, fold: UNREADABLE });
          if (!hold) self.reply({ id: request.id, fold: UNREADABLE });
        });
        workers.push(worker);
        return worker;
      },
    });

    // Act — one fold, then idle past the limit; then one left waiting when the source is closed.
    await folds.foldFor('s', 'claude', ALIASES);
    await waitFor(() => workers[0]?.terminated === true, 'the idle worker to be ended');
    const endedWhenIdle = workers[0]?.terminated;
    hold = true;
    const waiting = folds.foldFor('s', 'claude', ALIASES).catch((error: Error) => error.message);
    await waitFor(() => workers[1]?.sent.length === 1, 'the second fold to reach its worker');
    folds.close();

    // Assert
    should(endedWhenIdle).be.true();
    should(await waiting).equal('the analytics worker was closed');
    should(workers).have.length(2);
  });
});
