/**
 * How much resident memory each of `count` bundled session workers adds to a process, in MB, printed as
 * JSON (`tests/realworld/session/observer/worker-diet.test.ts`). Run in a process of its own, for two
 * reasons.
 *
 * Resident memory never shrinks back, so a measurement in the test runner's process would be measuring
 * every test before it.
 *
 * And the test runner must never host these threads, nor force a collection. `Bun.gc(true)` is
 * synchronous on the calling thread: on 2026-10-29 it wedged the shared `bun test` process on CI, here
 * and in the parse worker's finalization test, each time just after earlier files had terminated real
 * workers. No per-test timeout can fire there — its timer runs on the very thread that is stuck — and
 * the job held its runner for hours. Out here, a wedged measurement is a child the test kills at its
 * deadline, and the test fails saying so.
 */
const [url, count] = [process.argv[2], Number(process.argv[3] ?? '5')];
if (url === undefined || !Number.isInteger(count) || count < 1)
  throw new Error('usage: session-worker-rss.ts <worker url> [count]');
const rssMb = (): number => process.memoryUsage().rss / 1_048_576;
const settle = async (): Promise<void> => {
  for (let round = 0; round < 3; round += 1) {
    Bun.gc(true);
    await Bun.sleep(50);
  }
};
const probed = async (worker: Worker): Promise<void> =>
  await new Promise<void>(resolve => {
    worker.onmessage = () => resolve();
    worker.postMessage({ probe: true });
  });

// The Worker machinery's own one-time cost is paid first by a bare worker, so only the program is charged.
const bare = new Worker(URL.createObjectURL(new Blob(['self.onmessage = () => postMessage({ probe: true })'])));
await probed(bare);
bare.terminate();
await settle();
const before = rssMb();
const workers = Array.from({ length: count }, () => new Worker(url, { type: 'module' }));
for (const worker of workers) await probed(worker);
await Bun.sleep(200);
await settle();
process.stdout.write(JSON.stringify({ perWorkerMb: (rssMb() - before) / count }));
for (const worker of workers) worker.terminate();
// Ended here, not by the threads noticing: the parent waits for this process, and nothing else it holds.
process.exit(0);
