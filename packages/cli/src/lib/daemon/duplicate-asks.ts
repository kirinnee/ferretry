import type { DuplicateAsk } from '@ferretry/protocol';
import type { IDaemonHealthPort } from './ports.ts';

const plural = (count: number, unit: string): string => `${String(count)} ${unit}${count === 1 ? '' : 's'}`;

/**
 * What `fy doctor` says about asks the daemon suspects are the same ask twice but did not close
 * (docs/agenda.md § One ask per thing). A daemon that sends no `duplicateAsks` field predates the sweep: no lines.
 */
export function duplicateAskLines(duplicates: readonly DuplicateAsk[] | undefined, count?: number): string[] {
  if (duplicates === undefined) {
    return count === undefined || count === 0
      ? []
      : [`${plural(count, 'possible duplicate ask')} left open (the details are for the daemon's host)`];
  }
  if (duplicates.length === 0) return ['no duplicate asks on the agendas'];
  return [
    `${plural(duplicates.length, 'possible duplicate ask')} left open (the daemon closes only the ones it can prove):`,
    ...duplicates.map(
      each =>
        `  ${each.members.map(member => `!${member.id} on ${member.sessionId}`).join(' and ')}: ${each.kind} — ${each.why}`,
    ),
  ];
}

/** Ask the local daemon and render; a daemon that does not answer says nothing here (the host check already said so). */
export async function duplicateAskReport(health: IDaemonHealthPort): Promise<string[]> {
  const probed = await health.probe();
  return duplicateAskLines(probed?.duplicateAsks, probed?.duplicateAskCount);
}
