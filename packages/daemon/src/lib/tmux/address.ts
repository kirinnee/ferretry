/** Input errors are values at the boundary rather than unsafe tmux target strings. */
export class TmuxAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxAddressError';
  }
}

const NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

function segment(value: string, label: string): string {
  if (!NAME.test(value)) throw new TmuxAddressError(`${label} must be a lowercase tmux name`);
  return value;
}

export function sessionTarget(session: string): string {
  return segment(session, 'session');
}

export function windowTarget(session: string, window: string): string {
  return `${segment(session, 'session')}:${segment(window, 'window')}`;
}

export function paneTarget(session: string, window: string, pane: number): string {
  if (!Number.isSafeInteger(pane) || pane < 0) throw new TmuxAddressError('pane must be a non-negative integer');
  return `${windowTarget(session, window)}.${pane}`;
}
