/**
 * How a catalog review is READ, as pure functions over what the daemon answered.
 *
 * The daemon owns the review: every file in full, every command line, every warning. Nothing here
 * recomputes any of it. This module only decides how it is laid out: which entries are files, where
 * the hidden-character markers sit, which warning comes first, and how a long digest is shortened.
 * Both the "Add to catalog" sheet and the install confirm read through it, so one warning cannot be
 * worded two ways.
 */

import {
  type CatalogInstallWarning,
  type CatalogInstallWarningCode,
  type CatalogReviewEntry,
  revealHidden,
} from '@ferretry/protocol';

// ── Files and lines ──────────────────────────────────────────────────────────────────────────────

const SKILL_FILE_PREFIX = 'Skill file ';

/** A marker the review wrote for a hidden character: `⟨U+202E⟩`. Escapes keep this source plain. */
const MARKER = /⟨U\+[0-9A-F]{4,6}⟩/gu;
/** Markers with nothing between them. */
const MARKER_RUN = /(?:⟨U\+[0-9A-F]{4,6}⟩)+/gu;

export interface TextSegment {
  readonly marker: boolean;
  readonly text: string;
}

/** A run of markers, with each stretch of the same one written once and counted: `⟨U+200B ×1,000⟩`. */
const runLabel = (run: string): string => {
  const tokens: { readonly token: string; count: number }[] = [];
  for (const token of run.slice(0, -1).split('⟩')) {
    const last = tokens.at(-1);
    if (last?.token === token) last.count += 1;
    else tokens.push({ token, count: 1 });
  }
  return tokens
    .map(({ token, count }) => (count === 1 ? `${token}⟩` : `${token} ×${count.toLocaleString('en-US')}⟩`))
    .join('');
};

/**
 * Splits review text so each run of hidden-character markers can be drawn on its own, as ONE mark that
 * counts repeats, so a file of a million zero-width spaces is one mark and not a million. Nothing but
 * that count is changed: the text between runs is kept as it was.
 */
export function splitMarkers(text: string): readonly TextSegment[] {
  const segments: TextSegment[] = [];
  let from = 0;
  for (const found of text.matchAll(MARKER_RUN)) {
    const at = found.index ?? 0;
    if (at > from) segments.push({ marker: false, text: text.slice(from, at) });
    segments.push({ marker: true, text: runLabel(found[0]) });
    from = at + found[0].length;
  }
  if (from < text.length) segments.push({ marker: false, text: text.slice(from) });
  return segments;
}

/** A file over this many bytes, or holding more markers than this, is shown closed until it is opened. */
export const LARGE_FILE_BYTES = 64 * 1024;
export const LARGE_FILE_MARKERS = 200;

export function isLargeFile(text: string): boolean {
  if (new TextEncoder().encode(text).length > LARGE_FILE_BYTES) return true;
  return text.split('⟨U+', LARGE_FILE_MARKERS + 2).length - 1 > LARGE_FILE_MARKERS;
}

export function holdsMarker(text: string): boolean {
  return new RegExp(MARKER.source, 'u').test(text);
}

/** A whole file of a skill, or one line of an MCP setup. */
export type ReviewRow =
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly text: string;
      readonly lines: number;
      readonly marked: boolean;
      /** Shown closed until opened: over {@link LARGE_FILE_BYTES}, or more than {@link LARGE_FILE_MARKERS} markers. */
      readonly large: boolean;
    }
  | {
      readonly kind: 'line';
      readonly label: string;
      readonly text: string;
      readonly marked: boolean;
      /** The secret NAME when the whole value is a `${secret:NAME}` placeholder. */
      readonly placeholder?: string;
    };

const PLACEHOLDER = /^\$\{secret:([A-Z][A-Z0-9_]*)\}$/u;

/** The name inside a value that is only a `${secret:NAME}` placeholder, else `undefined`. */
export function placeholderName(text: string): string | undefined {
  return PLACEHOLDER.exec(text)?.[1];
}

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length);

/** Entries in the order the daemon gave them (SKILL.md first), each as a file or a line. */
export function reviewRows(entries: readonly CatalogReviewEntry[]): readonly ReviewRow[] {
  return entries.map((entry): ReviewRow => {
    // The daemon already marks hidden characters; marking again is harmless and means a raw one never reaches the screen.
    const text = revealHidden(entry.text);
    const label = revealHidden(entry.label);
    const marked = holdsMarker(text);
    if (entry.document && label.startsWith(SKILL_FILE_PREFIX))
      return {
        kind: 'file',
        path: label.slice(SKILL_FILE_PREFIX.length),
        text,
        lines: lineCount(text),
        marked,
        large: isLargeFile(text),
      };
    const placeholder = label.startsWith('Environment ') ? placeholderName(text) : undefined;
    return placeholder === undefined
      ? { kind: 'line', label, text, marked }
      : { kind: 'line', label, text, marked, placeholder };
  });
}

/** What the publisher's preview says in place of a `${secret:NAME}` value. */
export const INSTALLER_FILLS_IN = 'The installer fills in their own';

/** Who is reading the review: the one adding to a catalog, or the one installing from it. */
export type ReviewAudience = 'publisher' | 'installer';

/** The heading over the files, for a skill; or the lines, for a setup. */
export function reviewHeading(rows: readonly ReviewRow[], audience: ReviewAudience = 'publisher'): string {
  const skill = rows.some(row => row.kind === 'file');
  if (audience === 'installer') return skill ? 'What this brings, in full' : 'It will run';
  return skill
    ? 'People who install this will see these files, in full'
    : 'People who install this will see this setup, in full';
}

// ── Warnings ─────────────────────────────────────────────────────────────────────────────────────

export type WarningTone = 'danger' | 'caution' | 'note';

interface WarningWords {
  readonly label: string;
  readonly tone: WarningTone;
  /** Lower comes first. The older version leads, because it is the one a person must not skim past. */
  readonly rank: number;
}

const WARNING_WORDS: Readonly<Record<CatalogInstallWarningCode, WarningWords>> = {
  'older-version': { label: 'Older version', tone: 'danger', rank: 0 },
  'hidden-characters': { label: 'Hidden characters', tone: 'danger', rank: 1 },
  'possible-secret': { label: 'May hold a secret', tone: 'danger', rank: 2 },
  'edited-locally': { label: 'Edited on this machine', tone: 'danger', rank: 3 },
  'runs-on-its-own': { label: 'Runs on its own', tone: 'caution', rank: 4 },
  'carries-scripts': { label: 'Carries scripts', tone: 'caution', rank: 5 },
  'unpinned-package': { label: 'No fixed version', tone: 'caution', rank: 6 },
  'package-registry': { label: 'Another package registry', tone: 'caution', rank: 7 },
  'network-url': { label: 'Runs on someone else’s computer', tone: 'caution', rank: 8 },
  'first-publisher': { label: 'First from this publisher', tone: 'note', rank: 9 },
};

export interface WarningRow {
  readonly code: CatalogInstallWarningCode;
  /** A short name for the kind of warning, so it never rests on colour alone. */
  readonly label: string;
  /** The daemon's own sentence, unchanged. */
  readonly text: string;
  readonly tone: WarningTone;
}

/** Every warning, the most serious first; ties keep the daemon's order. */
export function warningRows(warnings: readonly CatalogInstallWarning[]): readonly WarningRow[] {
  return warnings
    .map((warning, index) => ({ warning, index, words: WARNING_WORDS[warning.code] }))
    .toSorted((left, right) => left.words.rank - right.words.rank || left.index - right.index)
    .map(({ warning, words }) => ({ code: warning.code, label: words.label, text: warning.text, tone: words.tone }));
}

// ── Numbers and names ────────────────────────────────────────────────────────────────────────────

/** `sha256:9f2c1a7b3d04…` — enough to compare by eye; the full digest is shown on tap. */
export function shortDigest(digest: string): string {
  const [scheme, hex] = digest.split(':');
  return hex === undefined ? digest : `${scheme}:${hex.slice(0, 12)}…`;
}

/** How much of a publisher's fingerprint shows by default: 20 characters, which is 120 bits. */
const FINGERPRINT_SHOWN = 20;

/** `fy_daemon_q3XkAAAAAAAAAAAAAAAA…` — enough of a publisher's fingerprint to compare by eye; the rest is a tap away. */
export function fingerprintStart(daemonId: string): string {
  const prefix = 'fy_daemon_';
  const keep = daemonId.startsWith(prefix) ? prefix.length + FINGERPRINT_SHOWN : 14;
  return daemonId.length <= keep ? daemonId : `${daemonId.slice(0, keep)}…`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
