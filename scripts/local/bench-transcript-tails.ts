/**
 * How many `stat` calls transcript-tail reads cost per second on the owner-scale fleet, with and
 * without the file-event hub — the before/after number for the hub's first consumer.
 *
 * It drives the daemon's own `TranscriptTailCache` the way the daemon does (one tail per session per
 * roster listing: the warden's liveness pass, the question reconcile, every session read) over the
 * transcripts of `scaledFleet`, while the running sessions keep appending to theirs, and counts the
 * fingerprint `stat`s each mode makes. The parse itself is stubbed: this measures re-validation, not
 * parsing, which the cache already skips for unchanged bytes in both modes.
 *
 * Manual only. Linux (inotify) or macOS (FSEvents).
 *
 *   bun scripts/local/bench-transcript-tails.ts [--fixture /tmp/fy-idle-fixture] [--seconds 20]
 *     [--listings-per-second 1] [--appends-per-second 2]
 */
import { appendFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { unrefFileEventTimers } from '../../packages/daemon/src/adapters/file-events/bun-file-event-source.ts';
import { platformFileEventSource } from '../../packages/daemon/src/adapters/file-events/platform.ts';
import { FileEventHub } from '../../packages/daemon/src/lib/file-events/hub.ts';
import { TranscriptTailCache } from '../../packages/daemon/src/lib/session/transcript/tail-cache.ts';
import { OWNER_MAC_FLEET, scaledFleet } from '../../packages/daemon/tests/integration/support/scaled-fleet.ts';

const { values } = parseArgs({
  options: {
    fixture: { type: 'string', default: '/tmp/fy-idle-fixture' },
    seconds: { type: 'string', default: '20' },
    'listings-per-second': { type: 'string', default: '1' },
    'appends-per-second': { type: 'string', default: '2' },
  },
});
const seconds = Number(values.seconds);
const listingsPerSecond = Number(values['listings-per-second']);
const appendsPerSecond = Number(values['appends-per-second']);

const fleet = await scaledFleet(values.fixture, { ...OWNER_MAC_FLEET, running: 5 });
const homes = join(fleet.home, 'fleet', 'homes');
const claude: string[] = [];
for (const runtime of await readdir(homes)) {
  const projects = join(homes, runtime, 'projects', '-work');
  for (const name of await readdir(projects).catch(() => []))
    if (name.endsWith('.jsonl')) claude.push(join(projects, name));
}
const rollouts: string[] = [];
const days = join(homes, 'codex-kirin', 'sessions', '2026', '10');
for (const day of (await readdir(days)).toSorted()) {
  for (const name of await readdir(join(days, day))) rollouts.push(join(days, day, name));
  if (rollouts.length >= fleet.shape.sessions - claude.length) break;
}
const transcripts = [...claude, ...rollouts].slice(0, fleet.shape.sessions);
const running = transcripts.slice(0, fleet.shape.running);

async function measure(events: boolean): Promise<{ stats: number; asks: number; perSecond: number }> {
  const hub = events ? new FileEventHub(platformFileEventSource(), unrefFileEventTimers) : undefined;
  const cache = new TranscriptTailCache(
    undefined,
    undefined,
    hub === undefined ? undefined : { changes: hub, now: () => Date.now() },
  );
  let stats = 0;
  let asks = 0;
  const listing = async (): Promise<void> => {
    await Promise.all(
      transcripts.map(async (file, index) => {
        asks += 1;
        await cache.tail(
          `s${String(index)}`,
          file,
          400,
          async () => {
            stats += 1;
            return await stat(file).then(
              info => ({ file, size: info.size, mtimeMs: info.mtimeMs }),
              () => undefined,
            );
          },
          async () => [],
        );
      }),
    );
  };
  // Warm: the first listings parse, watch and verify; they are not what an idle fleet pays.
  await listing();
  await listing();
  stats = 0;
  asks = 0;
  const appender = setInterval(() => {
    for (const file of running) void appendFile(file, '{"type":"progress"}\n');
  }, 1_000 / appendsPerSecond);
  const started = Date.now();
  while (Date.now() - started < seconds * 1_000) {
    await listing();
    await Bun.sleep(1_000 / listingsPerSecond);
  }
  clearInterval(appender);
  const elapsed = (Date.now() - started) / 1_000;
  cache.close();
  hub?.close();
  return { stats, asks, perSecond: stats / elapsed };
}

const before = await measure(false);
const after = await measure(true);
const line = (label: string, result: { stats: number; asks: number; perSecond: number }): string =>
  `${label.padEnd(18)} ${result.perSecond.toFixed(1).padStart(7)} stat/s  (${String(result.stats)} stats for ${String(result.asks)} tail asks)`;
console.log(
  `${String(transcripts.length)} transcripts, ${String(running.length)} appending ${String(appendsPerSecond)}/s, ${String(listingsPerSecond)} listing(s)/s, ${String(seconds)} s`,
);
console.log(line('stat every ask', before));
console.log(line('file-event hub', after));
