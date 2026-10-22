/**
 * How much resident memory starting one bundled housekeeping worker adds to a process, in MB, printed
 * as JSON. Run in a process of its own: resident memory never shrinks back, so a second measurement in
 * one process would be measuring the first.
 *
 * The Worker machinery's own one-time cost is paid first by a bare worker, so only the program is
 * charged; the worker then answers its probe and one real job, so its modules have all been evaluated.
 */
const url = process.argv[2];
if (url === undefined) throw new Error('usage: worker-rss.ts <worker url>');
const rssMb = (): number => process.memoryUsage().rss / 1_048_576;
const settle = async (): Promise<void> => {
  for (let round = 0; round < 3; round += 1) {
    Bun.gc(true);
    await Bun.sleep(50);
  }
};
const answered = async (
  worker: Worker,
  message: unknown,
  done: (data: { type?: string; probe?: boolean }) => boolean,
) =>
  await new Promise<void>(resolve => {
    worker.onmessage = (event: MessageEvent<{ type?: string; probe?: boolean }>) => {
      if (done(event.data)) resolve();
    };
    worker.postMessage(message);
  });

const bare = new Worker(URL.createObjectURL(new Blob(['self.onmessage = () => postMessage({ probe: true })'])));
await answered(bare, {}, () => true);
bare.terminate();
await settle();
const before = rssMb();
const worker = new Worker(url, { type: 'module' });
await answered(worker, { probe: true }, data => data.probe === true);
worker.postMessage({
  type: 'settings',
  platform: 'linux',
  keychainAccount: 'nobody',
  defaultClaudeHome: '/nonexistent/claude',
  fleetRoot: '/nonexistent/fleet',
});
await answered(
  worker,
  {
    type: 'job',
    id: 1,
    job: {
      kind: 'credential.local',
      resolution: { harness: 'codex', store: 'ferretry', canonicalFile: '/nonexistent/auth.json' },
    },
  },
  data => data.type === 'result',
);
await settle();
process.stdout.write(JSON.stringify({ addedMb: rssMb() - before }));
worker.terminate();
