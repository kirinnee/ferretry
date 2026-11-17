import { isJobAttachCommand } from '@ferretry/std';
import type { KeptAttachment } from '../../../contract/job-keeping.ts';
import { isCommandShell } from './agent-jobs.ts';
import { classifyAroundMoveRequest } from './command-classifier.ts';
import type { KnownProcess } from './harness-provenance.ts';
import type { ProcRow } from './process-table.ts';

/** What the card says of an attachment: the job is the keeper's, so the move leaves it alone. */
const attachedLabel = (job: { readonly jobName: string; readonly jobEnded?: boolean }): string =>
  job.jobEnded === true
    ? `attachment to job ${job.jobName} (the job has already ended; this attachment is just exiting)`
    : `attachment to job ${job.jobName} (kept; re-attach after the move)`;

/**
 * Adds the `job-attachment` processes to what provenance already recognised.
 *
 * THE KEEPER'S REGISTRY IS THE PROOF, AND THE ARGV IS A SECOND, NECESSARY CHECK — never either alone. The registry says
 * the pid registered as an attachment of this ferret (and an entry whose pid was reused is pruned); the row's own command
 * line must STILL be `<binary> job attach|run …`, so a registry entry forged for some other program (any pid the ferret's
 * own credential can name) never makes that program look safe. A row is an attachment only when its pid is listed, its
 * argv matches, AND it sits in this pane's tree (`rows` is the pane's descendants).
 *
 * An attachment is safe to kill: the job is not its child, and the keeper is asked to detach it first. The tool shell
 * wrapped around it (Claude's `zsh -c … eval 'fy job attach x'`) is just as safe, but ONLY when it carries nothing else:
 * every row the shell started is the attachment or another command shell, AND each of those shells' own program, with the
 * attach call taken out, is safe (the requester-chain rule of `requester-call.ts`): `fy job attach x && make` has not
 * started `make` yet, so the shell keeps its own verdict. `shellOf` maps each row to the tool shell it belongs to
 * (see `identifyAgentJobs`).
 */
export function markJobAttachments(
  rows: readonly ProcRow[],
  known: ReadonlyMap<number, KnownProcess>,
  shellOf: ReadonlyMap<number, number>,
  attachments: readonly KeptAttachment[],
  binaryName: string,
): ReadonlyMap<number, KnownProcess> {
  if (attachments.length === 0) return known;
  const byPid = new Map(attachments.map(entry => [entry.pid, entry]));
  const isAttachCall = (segment: string): boolean => isJobAttachCommand(segment, binaryName);
  const result = new Map(known);
  const attached = new Set<number>();
  for (const row of rows) {
    const entry = byPid.get(row.pid);
    if (entry === undefined || known.has(row.pid)) continue;
    if (!isAttachCall(row.command ?? row.argv)) continue;
    attached.add(row.pid);
    result.set(row.pid, {
      kind: 'job-attachment',
      label: attachedLabel(entry),
      attachment: {
        jobId: entry.jobId,
        jobName: entry.jobName,
        ...(entry.jobEnded === true ? { jobEnded: true as const } : {}),
      },
    });
  }
  const groups = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const shell = shellOf.get(row.pid);
    if (shell !== undefined) groups.set(shell, [...(groups.get(shell) ?? []), row]);
  }
  for (const group of groups.values()) {
    const held = group.filter(row => attached.has(row.pid));
    if (held.length === 0) continue;
    const carriesOnlyTheAttachment = group.every(
      row => attached.has(row.pid) || (isCommandShell(row.argv) && shellRestIsSafe(row, isAttachCall)),
    );
    if (!carriesOnlyTheAttachment) continue;
    const first = result.get(held[0]?.pid ?? 0);
    for (const row of group)
      if (!attached.has(row.pid))
        result.set(row.pid, {
          kind: 'job-attachment',
          label: first?.label ?? attachedLabel({ jobName: 'job' }),
        });
  }
  return result;
}

/** What the shell would still do besides its attach call; exact where the kernel gave the words, else the lossy text. */
const shellRestIsSafe = (row: ProcRow, isCall: (segment: string) => boolean): boolean =>
  (row.command === undefined
    ? classifyAroundMoveRequest(row.argv, 'lossy', isCall)
    : classifyAroundMoveRequest(row.command, 'exact', isCall)) === 'safe_to_kill';
