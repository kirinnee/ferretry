/**
 * `hostHistory` in `harness-claude-code.yaml`: whether Ferretry may READ the conversations in `~/.claude` (default on).
 * Read with the shared config reader and set with the shared one-key editor, so every YAML form reads right and every
 * other key and comment stays as it was. A text the route withholds, or that does not read, is "unknown": the page then
 * writes nothing.
 */
import { editConfigText, readConfigText } from '@ferretry/std/yaml';

/** The comment the route answers in place of a text it will not show (kernel `withheldComment`). */
const WITHHELD = /^# ‹hidden›: the text of this file is not shown because/u;

export type HistoryRead = { readonly kind: 'on' | 'off' } | { readonly kind: 'unknown' };

export const historyRead = (text: string, state?: string): HistoryRead => {
  if (WITHHELD.test(text) || state === 'invalid') return { kind: 'unknown' };
  const read = readConfigText(text);
  if (!read.ok) return { kind: 'unknown' };
  const value = read.read.value;
  if (value === null || value === undefined) return { kind: 'on' };
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'unknown' };
  const { hostHistory: raw } = value as { readonly hostHistory?: unknown };
  if (raw === undefined || raw === null) return { kind: 'on' };
  return typeof raw === 'boolean' ? { kind: raw ? 'on' : 'off' } : { kind: 'unknown' };
};

/** The file with `hostHistory` set and every other key and comment left exactly as it was. */
export const withHostHistory = (text: string, on: boolean): string => {
  const read = readConfigText(text);
  if (!read.ok || historyRead(text).kind === 'unknown') throw new Error('the file cannot be edited here');
  const value = read.read.value;
  const now = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return editConfigText(text, { ...now, hostHistory: on }, now, undefined);
};
