import { AccountCommandError } from './account-ports.ts';

const RELATIVE = /^(\d+)\s*([mhdw])$/i;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

const WRITE_IT =
  'Write --until as a date (2026-11-01, the start of that day in UTC), a time (2026-11-01T09:00:00Z) or a wait (3d, 12h, 90m).';

/**
 * `--until` as the instant the switch turns itself back on, or a refusal in plain words. A bare date
 * is the START of that day in UTC; a wait counts from `now` (ms). A time already past is refused: it
 * would never have switched anything off.
 */
export function parseUntil(text: string, now: number): string {
  const word = text.trim();
  const relative = RELATIVE.exec(word);
  let ms: number;
  if (relative !== null) {
    ms = now + Number(relative[1]) * UNIT_MS[(relative[2] as string).toLowerCase() as keyof typeof UNIT_MS];
  } else if (DATE.test(word)) {
    ms = Date.parse(`${word}T00:00:00Z`);
  } else if (INSTANT.test(word)) {
    ms = Date.parse(word);
  } else {
    throw new AccountCommandError(`"${text}" is not a time I can read. ${WRITE_IT}`);
  }
  if (Number.isNaN(ms)) throw new AccountCommandError(`"${text}" is not a real time. ${WRITE_IT}`);
  if (ms <= now) throw new AccountCommandError(`"${text}" has already passed, so it would turn nothing off.`);
  return new Date(ms).toISOString();
}

/** The `--reason` text, trimmed; a blank one is refused. */
export function parseReason(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const reason = text.trim();
  if (reason === '') throw new AccountCommandError('Say why in --reason, or leave it out.');
  return reason;
}
