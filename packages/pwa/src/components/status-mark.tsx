import type { SessionView } from '@ferretry/protocol';

type StatusShape = 'circle' | 'diamond' | 'square';
type StatusTone = 'ok' | 'warn' | 'err' | 'accent';

interface StatusMarkInfo {
  readonly shape: StatusShape;
  readonly tone: StatusTone;
  readonly label: string;
  readonly live: boolean;
}

const terminalStatuses = new Set(['completed', 'failed', 'stalled', 'stopped', 'kill_failed']);
const humanWaitingStatuses = new Set(['awaiting_question', 'awaiting_user']);

/**
 * Status is never colour alone: live work is a circle, declared or human
 * waiting is a diamond, and terminal work is a square. The complete wording
 * is available to both screen readers and pointer users.
 */
export const statusMark = (view: Pick<SessionView, 'state'>): StatusMarkInfo => {
  const { status, waiting } = view.state;
  if (terminalStatuses.has(status)) {
    return {
      shape: 'square',
      tone: status === 'completed' ? 'ok' : 'err',
      label: `finished — ${status.replaceAll('_', ' ')}`,
      live: false,
    };
  }
  if (waiting || status === 'waiting' || humanWaitingStatuses.has(status)) {
    const detail = waiting
      ? `parked${waiting.peerName ? ` for ${waiting.peerName}` : ''}${waiting.condition ? `: ${waiting.condition}` : ''}`
      : status.replaceAll('_', ' ');
    return {
      shape: 'diamond',
      tone: humanWaitingStatuses.has(status) ? 'accent' : 'warn',
      label: `waiting — ${detail}`,
      live: false,
    };
  }
  return { shape: 'circle', tone: 'warn', label: `active — ${status.replaceAll('_', ' ')}`, live: true };
};

export function StatusMark({ view, size = 8 }: { readonly view: Pick<SessionView, 'state'>; readonly size?: number }) {
  const info = statusMark(view);
  return (
    <span
      aria-label={info.label}
      className="fy-status-mark"
      role="img"
      style={{ height: size + 4, width: size + 4 }}
      title={info.label}
    >
      <span
        aria-hidden="true"
        className={`fy-status-mark-glyph fy-status-mark-${info.shape} fy-status-mark-${info.tone}${info.live ? ' fy-status-mark-live' : ''}`}
        style={{ height: size, width: size }}
      />
    </span>
  );
}
