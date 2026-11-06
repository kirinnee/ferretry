/**
 * Reading what the kernel counted about a cgroup's memory (`memory.events`, cgroup-v2).
 *
 * A TICK IS A DIFFERENCE. The counters only grow, so "this ferret is being slowed" means `high` ROSE
 * since the last look, and "something in it was killed for memory" means `oom_kill` rose. A first look
 * is a baseline and says nothing: a counter that is 40 on first sight is history, not news.
 *
 * Pure: no IO, no clock.
 */
import type { MemoryEvents } from './ports.ts';

const ZERO: MemoryEvents = { high: 0, max: 0, oom: 0, oomKill: 0 };

/** The `memory.events` text (`high 5\nmax 0\noom 0\noom_kill 0`), or `undefined` when it is not that. */
export function parseMemoryEvents(text: string): MemoryEvents | undefined {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(\w+)\s+(\d+)$/u.exec(line.trim());
    if (match !== null) counts.set(match[1] as string, Number(match[2]));
  }
  if (counts.size === 0) return undefined;
  return {
    high: counts.get('high') ?? 0,
    max: counts.get('max') ?? 0,
    oom: counts.get('oom') ?? 0,
    oomKill: counts.get('oom_kill') ?? 0,
  };
}

/** How much each counter grew; a counter that went down (a recreated cgroup) counts as no growth. */
export function eventsGrowth(before: MemoryEvents | undefined, after: MemoryEvents): MemoryEvents {
  if (before === undefined) return ZERO;
  const grew = (now: number, was: number): number => Math.max(0, now - was);
  return {
    high: grew(after.high, before.high),
    max: grew(after.max, before.max),
    oom: grew(after.oom, before.oom),
    oomKill: grew(after.oomKill, before.oomKill),
  };
}
