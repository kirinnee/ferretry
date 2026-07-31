import type { TaskActivity } from '@ferretry/protocol';
import { taskReference } from './task-id';

/**
 * One-line human summary of a history record, shared by the terminal and markdown renderers so both
 * describe the same event the same way.
 *
 * Unlike kteam's version this switches on the discriminated union rather than indexing `data` with
 * string keys, so a `session` record can no longer print `undefined reopen-ack` for the half of the
 * union that carries no `session` field.
 */
export function summarizeTaskActivity(entry: TaskActivity): string {
  switch (entry.type) {
    case 'created':
      return `as ${entry.data.status} — ${entry.data.reason}`;
    case 'status': {
      const prefix = entry.data.reopened === true ? 'REOPENED ' : entry.data.backward === true ? 'MOVED BACK ' : '';
      const note = entry.data.note === undefined ? '' : `: ${entry.data.note}`;
      return `${prefix}${entry.data.phaseFrom} → ${entry.data.phaseTo} (${entry.data.reason})${note}`;
    }
    case 'note':
    case 'feedback':
      return entry.data.text;
    case 'clarification':
      return `${entry.data.text} (${entry.data.source})`;
    case 'dependency':
      return `${entry.data.operation} ${taskReference(entry.data.taskId)}`;
    case 'file': {
      const reason = entry.data.reason === undefined ? '' : ` (${entry.data.reason})`;
      return `${entry.data.operation} \`${entry.data.path}\`${reason}`;
    }
    case 'link':
      return `${entry.data.field} = ${entry.data.value}`;
    case 'assign':
      return `${entry.data.from ?? '—'} → ${entry.data.to ?? '—'}`;
    case 'order':
      return `${entry.data.from ?? '—'} → ${entry.data.to ?? '—'}`;
    case 'session':
      return entry.data.event === 'completion-claim'
        ? `${entry.data.session} claimed ${entry.data.phase} complete at turn ${entry.data.turn}`
        : `reopen ${entry.data.reopenAck} acknowledged by ${entry.data.resolvedByName ?? entry.data.resolvedBy}`;
  }
}
