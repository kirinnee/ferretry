import type { DurationStats, PerformanceReport, SessionWorkerPool } from './performance.ts';

/**
 * The session-worker pool in one line, for `fy daemon status` and every performance report alike:
 * `pool of 2 · 2 threads observing 3, 2 sessions`, or that the main thread observes them all.
 */
export function describeSessionWorkerPool(pool: SessionWorkerPool): string {
  if (!pool.enabled)
    return 'off — every running session is observed on the main thread (sessionWorkers.enabled: false)';
  const size = `pool of ${String(pool.max)}`;
  if (pool.threads === 0) return `${size} · no thread running (no session is running)`;
  const spread = pool.sessionsPerThread.join(', ');
  return `${size} · ${String(pool.threads)} thread${pool.threads === 1 ? '' : 's'} observing ${spread} session${pool.sessionsPerThread.length === 1 && pool.sessionsPerThread[0] === 1 ? '' : 's'}`;
}

/** How many rows of each table the text shows; `--json` carries all of them. */
const ROWS = 12;

const ms = (value: number): string =>
  value >= 1_000 ? `${(value / 1_000).toFixed(1)} s` : `${value >= 10 ? Math.round(value) : value.toFixed(1)} ms`;
const num = (value: number): string => (Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(1));
const pct = (share: number): string => `${Math.round(share * 100)}%`;
/** Who started a command's children: ` · by turn watcher 300, fleet refresh 12`; nothing when unknown. */
const starters = (by: readonly { readonly activity: string; readonly count: number }[] | undefined): string =>
  by === undefined || by.length === 0
    ? ''
    : ` · by ${by.map(entry => `${entry.activity} ${num(entry.count)}`).join(', ')}`;
const wall = (stats: DurationStats): string =>
  `p50 ${ms(stats.p50Ms)} · p95 ${ms(stats.p95Ms)} · max ${ms(stats.maxMs)} · total ${ms(stats.totalMs)}`;

/**
 * `fy daemon profile` as a person reads it: the budgets it broke first, then where the time went —
 * CPU, the event loop, the hottest code, child processes, timers, routes, files — each table busiest
 * first and cut to its top rows. Every line is already free of content and secrets, because the report
 * is; this only lays it out.
 */
export function renderPerformanceReport(report: PerformanceReport): string {
  const lines: string[] = [];
  const seconds = Math.round(report.windowMs / 1_000);
  lines.push(
    `Daemon profile — ${String(seconds)} s · ${report.daemon.version} on ${report.daemon.platform}/${report.daemon.arch} (${report.daemon.runtime}) · up ${ms(report.daemon.uptimeSeconds * 1_000)}`,
  );
  if (report.fleet !== undefined)
    lines.push(`Fleet: ${String(report.fleet.sessions)} sessions, ${String(report.fleet.running)} running`);

  if (report.budgets.length > 0) {
    lines.push('', 'Budgets (an idle daemon)');
    for (const budget of [...report.budgets].sort((a, b) => Number(a.ok) - Number(b.ok)))
      lines.push(
        `  ${budget.ok ? 'ok  ' : 'OVER'}  ${budget.name}: ${num(budget.actual)} ${budget.unit} (limit ${num(budget.limit)})`,
      );
  }

  const cpu = report.resources.cpu;
  lines.push(
    '',
    `CPU      ${num(cpu.percentOfCore)}% of one core · user ${ms(cpu.userMs)} · system ${ms(cpu.systemMs)}${
      cpu.childrenMs === undefined ? '' : ` · children ${ms(cpu.childrenMs)}`
    }`,
  );
  const memory = report.resources.memory;
  lines.push(
    `Memory   rss ${num(memory.rssMb.mean)} MB (max ${num(memory.rssMb.max)}) · heap ${num(memory.heapUsedMb.mean)} MB · external ${num(memory.externalMb.mean)} MB`,
  );
  if (report.resources.syscalls !== undefined)
    lines.push(
      `Syscalls ${num(report.resources.syscalls.perSecond)}/s read+write (${num(report.resources.syscalls.reads)} reads, ${num(report.resources.syscalls.writes)} writes)`,
    );
  lines.push(
    `Switches ${num(report.resources.contextSwitches.voluntary)} voluntary · ${num(report.resources.contextSwitches.involuntary)} involuntary`,
  );

  const loop = report.eventLoop;
  lines.push(
    '',
    `Event loop  lag p50 ${ms(loop.lag.p50Ms)} · p95 ${ms(loop.lag.p95Ms)} · max ${ms(loop.lag.maxMs)} · ${String(loop.blocksOver100Ms)} blocks over 100 ms (${String(loop.blocksOver250Ms)} over 250 ms), ${ms(loop.blockedMs)} blocked`,
  );
  for (const stall of loop.stalls.slice(0, 5)) {
    const during = stall.during.length === 0 ? 'no named work' : stall.during.join(', ');
    const hottest = stall.stacks[0];
    lines.push(
      `  ${ms(stall.durationMs)} at +${ms(stall.atOffsetMs)} during ${during}${hottest === undefined ? '' : ` — ${pct(hottest.share)} in ${hottest.stack}`}`,
    );
  }

  const profile = report.cpuProfile;
  if (profile.samples > 0) {
    lines.push('', `Hot functions — self time, of ${num(profile.samples)} samples`);
    for (const entry of profile.self.slice(0, ROWS)) lines.push(`  ${pct(entry.share).padStart(4)}  ${entry.frame}`);
    lines.push('Hot functions — including callees');
    for (const entry of profile.inclusive.slice(0, ROWS))
      lines.push(`  ${pct(entry.share).padStart(4)}  ${entry.frame}`);
    lines.push('Hot stacks');
    for (const entry of profile.stacks.slice(0, 5)) lines.push(`  ${pct(entry.share).padStart(4)}  ${entry.stack}`);
  }

  const children = report.childProcesses;
  lines.push('', `Child processes  ${num(children.total)} (${num(children.perMinute)}/min)`);
  for (const entry of children.commands.slice(0, ROWS))
    lines.push(
      `  ${num(entry.perMinute).padStart(7)}/min  ${entry.command}${entry.synchronous > 0 ? ` (${String(entry.synchronous)} synchronous)` : ''} — ${wall(entry.wall)}${starters(entry.by)}`,
    );

  if (report.activities.length > 0) {
    lines.push('', 'Timers and background work — by total wall time');
    for (const entry of report.activities.slice(0, ROWS))
      lines.push(`  ${entry.name} — ${num(entry.perMinute)}/min · ${wall(entry.wall)}`);
  }

  if (report.routes.length > 0) {
    lines.push('', 'Routes — by total wall time');
    for (const entry of report.routes.slice(0, ROWS))
      lines.push(
        `  ${entry.route} — ${num(entry.perMinute)}/min · ${wall(entry.wall)}${entry.errors > 0 ? ` · ${String(entry.errors)} errors` : ''} · ${num(Math.round(entry.bytes.total / 1_024))} KB`,
      );
  }

  const files = report.fileOperations;
  lines.push('', `File operations (the state-home port)  ${num(files.total)} (${num(files.perSecond)}/s)`);
  for (const entry of files.top.slice(0, ROWS))
    lines.push(
      `  ${num(entry.perSecond).padStart(7)}/s  ${entry.operation} ${entry.path} — p95 ${ms(entry.wall.p95Ms)}`,
    );

  if (report.sessionWorkers !== undefined)
    lines.push('', `Session workers  ${describeSessionWorkerPool(report.sessionWorkers)}`);

  if (report.workers.length > 0) {
    lines.push('', 'Workers — requests in flight');
    for (const worker of report.workers) {
      lines.push(`  ${worker.name}: mean ${num(worker.inFlight.mean)} · max ${num(worker.inFlight.max)}`);
      const work = worker.work;
      if (work === undefined) continue;
      lines.push(
        `    ${num(work.jobs)} jobs (${num(work.perMinute)}/min) · ${wall(work.wall)} · ${num(work.fileReads)} files read · ${num(work.fetches)} requests · heap max ${num(work.heapMb.max)} MB`,
      );
      for (const entry of work.childProcesses.slice(0, ROWS))
        lines.push(
          `    ${num(entry.perMinute).padStart(7)}/min  ${entry.command}${starters(entry.by)} — p95 ${ms(entry.wall.p95Ms)}`,
        );
    }
  }

  const trace = report.syscallTrace;
  if (trace !== undefined) {
    lines.push(
      '',
      `System calls (${trace.tool}, ${String(trace.seconds)} s)  ${num(trace.total)} (${num(trace.perSecond)}/s)`,
    );
    for (const entry of trace.top.slice(0, ROWS * 2))
      lines.push(`  ${num(entry.perSecond).padStart(7)}/s  ${entry.call} ${entry.path}`);
    if (trace.executions.length > 0) {
      lines.push('  programs started:');
      for (const entry of trace.executions.slice(0, ROWS))
        lines.push(`  ${num(entry.count).padStart(7)}  ${entry.command}`);
    }
  }

  if (report.limitations.length > 0) {
    lines.push('', 'What this report cannot see');
    for (const limitation of report.limitations) lines.push(`  - ${limitation}`);
  }
  return lines.join('\n');
}
