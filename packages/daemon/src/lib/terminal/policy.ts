import {
  TERMINAL_MAX_COLUMNS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MAX_TITLE_LENGTH,
  TERMINAL_MIN_COLUMNS,
  TERMINAL_MIN_ROWS,
  type TerminalSize,
} from '@ferretry/protocol';

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 100, rows: 30 };

export class TerminalPolicyError extends Error {
  constructor(override readonly message: string) {
    super(message);
    this.name = 'TerminalPolicyError';
  }
}

export function normalizeTerminalSize(cols: number, rows: number): TerminalSize {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    throw new TerminalPolicyError('terminal dimensions must be finite numbers');
  }
  return {
    cols: Math.max(TERMINAL_MIN_COLUMNS, Math.min(TERMINAL_MAX_COLUMNS, Math.round(cols))),
    rows: Math.max(TERMINAL_MIN_ROWS, Math.min(TERMINAL_MAX_ROWS, Math.round(rows))),
  };
}

export function normalizeTerminalTitle(value: unknown): string {
  if (typeof value !== 'string') throw new TerminalPolicyError('terminal title must be a string');
  const title = value.trim();
  if (!title) throw new TerminalPolicyError('terminal title cannot be empty');
  if (title.length > TERMINAL_MAX_TITLE_LENGTH) {
    throw new TerminalPolicyError(`terminal title must be no longer than ${TERMINAL_MAX_TITLE_LENGTH} characters`);
  }
  if (/[\p{Cc}\p{Cf}]/u.test(title)) throw new TerminalPolicyError('terminal title cannot contain control characters');
  return title;
}

export function nextTerminalTitle(existingTitles: readonly string[], maximumPerSession: number): string {
  const used = new Set(existingTitles);
  for (let index = 1; index <= maximumPerSession + 1; index += 1) {
    const title = `Terminal ${index}`;
    if (!used.has(title)) return title;
  }
  return 'Terminal';
}

export function idleDeadline(lastActivityAtMs: number, viewerCount: number, idleTimeoutMs: number): number | undefined {
  if (!Number.isFinite(lastActivityAtMs) || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new TerminalPolicyError('terminal activity and timeout must be finite positive values');
  }
  if (!Number.isInteger(viewerCount) || viewerCount < 0)
    throw new TerminalPolicyError('terminal viewer count must be non-negative');
  return viewerCount === 0 ? lastActivityAtMs + idleTimeoutMs : undefined;
}

export function isTerminalIdle(
  lastActivityAtMs: number,
  viewerCount: number,
  nowMs: number,
  idleTimeoutMs: number,
): boolean {
  const deadline = idleDeadline(lastActivityAtMs, viewerCount, idleTimeoutMs);
  return deadline !== undefined && nowMs >= deadline;
}
