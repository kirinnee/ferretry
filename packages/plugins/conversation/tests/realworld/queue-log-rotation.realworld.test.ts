// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { afterAll, describe, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { state as kernelState } from '@ferretry/kernel/host';
import should from 'should';
import { CONVERSATION_STATE } from '../../contract/index.ts';
import { StateQueueStore } from '../../daemon/queue/adapters/index.ts';
import { foldQueue } from '@ferretry/core-mailbox/contract';
import { parseSessionId } from '../../daemon/seams/ferret-id.ts';
import { LightState } from '../support/light-state.ts';
import { queueHistory } from '../support/queue-history.ts';

const F1 = parseSessionId('f1');
const folders: string[] = [];
afterAll(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

/** The state a ferret that has seen `events` events leaves on a real disk, written without an fsync per line. */
async function ledOnDisk(events: number) {
  const staged = new LightState();
  const history = queueHistory(21, events);
  const store = new StateQueueStore(staged.port());
  for (const event of history) await store.append(F1, event);
  const home = await mkdtemp(join(tmpdir(), 'fy-queue-rotation-'));
  folders.push(home);
  const put = async (relative: string, text: string): Promise<void> => {
    const target = join(home, 'state', 'conversation', relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  for (const [relative, lines] of staged.logs) await put(relative, `${lines.join('\n')}\n`);
  for (const [relative, text] of staged.documents) await put(relative, `${text}\n`);
  const port = kernelState.createStatePort({
    home,
    pluginId: 'conversation',
    files: CONVERSATION_STATE,
    fs: kernelState.createNodeHostFs(),
  });
  return { history, port };
}

const median = (samples: number[]): number =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] as number;

describe('looking at a queue that has seen 200,000 events', () => {
  test('should cost a few milliseconds, where reading the whole log cost ~420 ms', async () => {
    // Arrange — a real disk, a real state port, and the log of a ferret that has been busy for a long time.
    const { history, port } = await ledOnDisk(200_000);
    const cold = new StateQueueStore(port);

    // Act — the first look after a restart reads the live segment and every shard once.
    const coldStart = performance.now();
    const first = await cold.messages(F1);
    const coldMs = performance.now() - coldStart;
    // Then the deliverer's several reads per look, and a look after one more line was appended.
    const unchanged: number[] = [];
    for (let look = 0; look < 200; look += 1) {
      const t = performance.now();
      await cold.messages(F1);
      unchanged.push(performance.now() - t);
    }
    const appended: number[] = [];
    for (let line = 0; line < 50; line += 1) {
      const t = performance.now();
      await cold.append(F1, {
        v: 1,
        kind: 'moved',
        at: '2026-11-02T00:00:00.000Z' as never,
        id: 'ghost',
        state: 'read',
      });
      await cold.messages(F1);
      appended.push(performance.now() - t);
    }

    // Assert — the answer is the plain fold's, and the cost is the cost of a short file.
    should(first).eql(foldQueue(history));
    console.log(
      `queue log, 200,000 events: cold start ${coldMs.toFixed(1)} ms; unchanged look median ${median(unchanged).toFixed(3)} ms; append+look median ${median(appended).toFixed(3)} ms`,
    );
    should(median(unchanged)).be.below(5);
    should(median(appended)).be.below(20);
    should(coldMs).be.below(2_000);
  }, 110_000);
});
