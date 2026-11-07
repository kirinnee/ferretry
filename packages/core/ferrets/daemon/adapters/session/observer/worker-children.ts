import type { WorkerChild } from '../../../lib/session/observer/protocol.ts';

/** The runtime's two process starters, as the counter replaces them. */
export interface WorkerSpawnHost {
  spawn: typeof Bun.spawn;
  spawnSync: typeof Bun.spawnSync;
}

/** How much of a child's command line crosses back: the program and its subcommand, never its text. */
const ARGV_KEPT = 3;

const argvOf = (first: unknown): readonly string[] => {
  const argv = Array.isArray(first) ? first : (first as { cmd?: unknown } | undefined)?.cmd;
  return Array.isArray(argv) ? argv.slice(0, ARGV_KEPT).map(String) : [];
};

/**
 * Every child a session worker starts, held until the next report.
 *
 * The daemon's profiler counts children by replacing `Bun.spawn` — but a worker's `Bun` is its OWN
 * global, so the main thread's counter never sees a child a worker starts, and moving work into
 * workers would hide it from `fy daemon profile` (design §6.5). The worker counts its own here and
 * reports them with every look; the main thread labels and records them. Only the program and its
 * subcommand are kept — enough to name the row, nothing a pane printed.
 */
export function countWorkerChildren(host: WorkerSpawnHost, nowMs: () => number): () => readonly WorkerChild[] {
  let finished: WorkerChild[] = [];
  const spawn = host.spawn;
  const spawnSync = host.spawnSync;
  host.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const startedAt = nowMs();
    const child = spawn(...args);
    const argv = argvOf(args[0]);
    void child.exited.then(
      () => finished.push({ argv, wallMs: nowMs() - startedAt }),
      () => undefined,
    );
    return child;
  }) as typeof Bun.spawn;
  host.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    const startedAt = nowMs();
    try {
      return spawnSync(...args);
    } finally {
      finished.push({ argv: argvOf(args[0]), wallMs: nowMs() - startedAt });
    }
  }) as typeof Bun.spawnSync;
  return () => {
    const drained = finished;
    finished = [];
    return drained;
  };
}
