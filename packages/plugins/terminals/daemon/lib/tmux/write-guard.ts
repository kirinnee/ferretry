/** What tmux can compare in the very command that writes (copied from the input target). */
export interface WriteGuard {
  readonly panePid: number;
  readonly command: string;
  readonly cursorRow: number;
  readonly session?: string;
  readonly sessionCreated?: number;
}

/** A name tmux may safely compare in a format string. */
const PINNABLE_COMMAND = /^[A-Za-z0-9._:+@ -]+$/u;
export const GUARD_REFUSED = 'fy-input-guard-refused';

/** Compare and enqueue in the same tmux command; a refused predicate writes nothing. */
export function guardedWriteArguments(paneId: string, guard: WriteGuard, write: string): readonly string[] | undefined {
  if (
    !PINNABLE_COMMAND.test(guard.command) ||
    !/^%(?:0|[1-9][0-9]*)$/u.test(paneId) ||
    !Number.isSafeInteger(guard.panePid) ||
    guard.panePid <= 0 ||
    !Number.isSafeInteger(guard.cursorRow) ||
    guard.cursorRow < 0 ||
    (guard.session !== undefined && !PINNABLE_COMMAND.test(guard.session)) ||
    (guard.sessionCreated !== undefined && (!Number.isSafeInteger(guard.sessionCreated) || guard.sessionCreated <= 0))
  )
    return undefined;
  const condition = [
    `#{==:#{pane_id},${paneId}}`,
    `#{==:#{pane_pid},${guard.panePid}}`,
    `#{==:#{pane_current_command},${guard.command}}`,
    `#{==:#{cursor_y},${guard.cursorRow}}`,
    '#{==:#{pane_dead},0}',
    ...(guard.session === undefined ? [] : [`#{==:#{session_name},${guard.session}}`]),
    ...(guard.sessionCreated === undefined ? [] : [`#{==:#{session_created},${guard.sessionCreated}}`]),
  ].reduce((left, right) => `#{&&:${left},${right}}`);
  return ['if-shell', '-F', '-t', paneId, condition, write, `display-message -p ${GUARD_REFUSED}`];
}
