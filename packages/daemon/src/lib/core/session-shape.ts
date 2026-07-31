import type { HarnessKind } from './inventory.ts';

/**
 * Title-case a teammate callsign for display: `hayden` → `Hayden`, `mary-jane` → `Mary-Jane`.
 * Callsigns are lowercase letters, digits and hyphens, so capitalising each hyphen segment is the
 * whole job.
 */
function titleCaseCallsign(callsign: string): string {
  return callsign
    .split('-')
    .map(part => (part.length === 0 ? part : part[0]?.toUpperCase() + part.slice(1)))
    .join('-');
}

/**
 * The display title handed to the harness, so its own surfaces show the same `[Teammate] Task`
 * title the session list does.
 *
 * A title that already opens with a bracket is used verbatim, which keeps the prefixing idempotent:
 * a caller that hands over an already-composed title is passed through rather than doubled into
 * `[Team] [Team] …`. With no task title the bracketed callsign alone is the name, and with neither
 * the answer is nothing — passing an empty `--name` is worse than passing none.
 */
export function harnessDisplayName(config: { readonly teammate?: string; readonly name?: string }): string | undefined {
  const task = config.name?.trim();
  const teammate = config.teammate?.trim();
  const prefix = teammate === undefined || teammate.length === 0 ? undefined : `[${titleCaseCallsign(teammate)}]`;
  if (task !== undefined && task.startsWith('[')) return task;
  if (task !== undefined && task.length > 0 && prefix !== undefined) return `${prefix} ${task}`;
  return task === undefined || task.length === 0 ? prefix : task;
}

/**
 * The parent of a session being started.
 *
 * An explicit parent always wins. An unattended session started from inside another session's pane
 * inherits it, so delegated trees draw correctly in the session list and the warden's lineage. An
 * interactive session does not inherit: it is the human's own terminal, and an agent merely typed
 * the command — parenting the human under whichever agent invoked it renders the tree backwards.
 */
export function resolveParent(request: {
  readonly explicit?: string;
  readonly environmentSessionId?: string;
  readonly mode: 'auto' | 'interactive';
}): string | undefined {
  const explicit = request.explicit?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  if (request.mode === 'interactive') return undefined;
  const inherited = request.environmentSessionId?.trim();
  return inherited === undefined || inherited.length === 0 ? undefined : inherited;
}

const MAX_TMUX_NAME_LENGTH = 80;

/**
 * A tmux-safe session name.
 *
 * The suffix is what distinguishes one window of a session from another, so the identity is
 * truncated to make room for it rather than the whole name being cut at the end — the source cut
 * last, which could remove the suffix entirely and collide two different windows of one session.
 */
export function shellSafeSessionName(prefix: string, id: string, suffix: string): string {
  const safe = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '-');
  const tail = `-${safe(suffix)}`;
  const head = `${safe(prefix)}-`;
  const room = Math.max(0, MAX_TMUX_NAME_LENGTH - head.length - tail.length);
  return `${head}${safe(id).slice(0, room)}${tail}`.slice(0, MAX_TMUX_NAME_LENGTH);
}

/**
 * Extra arguments that add a remote-control surface to a launch.
 *
 * The generated session name is left to the harness and only its prefix is pinned, so the remote
 * surface labels the session with the teammate it belongs to while the harness still guarantees
 * uniqueness — a fixed name would collide across relaunches of one session.
 */
export function remoteControlArgs(
  config: { readonly harness: HarnessKind; readonly teammate?: string; readonly id: string },
  prefix: string,
): readonly string[] {
  if (config.harness !== 'claude') return [];
  const teammate = config.teammate?.trim();
  const label = teammate === undefined || teammate.length === 0 ? config.id : teammate;
  return ['--chrome', '--rc', '--remote-control-session-name-prefix', `${prefix}-${label}`];
}
