import type { SessionStatus } from '@ferretry/protocol';

/** A browser-safe, display-only transcript row. Content remains daemon-owned. */
export interface TranscriptEntry {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'tool' | 'notice';
  readonly text: string;
  readonly at?: number;
  readonly label?: string;
}

export const isTerminalSessionStatus = (status: SessionStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'stopped';

export const sessionStatusLabel = (status: SessionStatus): string => status.replaceAll('_', ' ');

export const relativeTime = (at: number | string | undefined, now = Date.now()): string => {
  if (!at) return '—';
  const timestamp = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const sessionNavigation = (daemonId: string, sessionId: string): readonly [string, string] => [
  daemonId,
  sessionId,
];

export const transcriptIsFollowing = (element: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean => element.scrollHeight - element.clientHeight - element.scrollTop <= 24;

export const composerUsesEnterToSend = (pointerFine: boolean, canHover: boolean): boolean => pointerFine && canHover;

export const canSubmitComposer = (draft: string, disabled: boolean, sending: boolean): boolean =>
  draft.trim().length > 0 && !disabled && !sending;
