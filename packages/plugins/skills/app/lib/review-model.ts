/**
 * How a local-copy review is READ, as pure functions over what the daemon answered (today's `catalog-review-model.ts`,
 * the part a copy from this machine uses).
 *
 * The daemon owns the review: every file in full, every warning. Nothing here recomputes any of it. This only decides how
 * it is laid out: which entries are files, where the hidden-character markers sit, which warning comes first.
 */
import { revealHidden } from '@ferretry/app/ui';
import type { SKILL_INSTALL_WARNING_CODES, SkillInstallWarning, SkillReviewEntry } from '../../contract/index.ts';

type SkillInstallWarningCode = (typeof SKILL_INSTALL_WARNING_CODES)[number];

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
const LARGE_FILE_MARKERS = 200;

export function isLargeFile(text: string): boolean {
  if (new TextEncoder().encode(text).length > LARGE_FILE_BYTES) return true;
  return text.split('⟨U+', LARGE_FILE_MARKERS + 2).length - 1 > LARGE_FILE_MARKERS;
}

/** What a collapsed file that a warning names still shows: this many lines, each cut at this many characters. */
const HEAD_LINES = 40;
const HEAD_LINE_CHARS = 400;

/** The start of a file for a collapsed view, never cutting a marker in half. */
export function fileHead(text: string): string {
  return text
    .split('\n', HEAD_LINES)
    .map(line => {
      if (line.length <= HEAD_LINE_CHARS) return line;
      const open = line.lastIndexOf('⟨', HEAD_LINE_CHARS);
      const close = open < 0 ? -1 : line.indexOf('⟩', open);
      const end = close >= HEAD_LINE_CHARS ? close + 1 : HEAD_LINE_CHARS;
      return `${line.slice(0, end)}…`;
    })
    .join('\n');
}

const WATCHED_WARNINGS: ReadonlySet<string> = new Set([
  'carries-scripts',
  'runs-on-its-own',
  'possible-secret',
  'hidden-characters',
]);

/** Whether a warning that says a file needs reading names this one by its path. */
export function namedByWarning(
  path: string,
  warnings: readonly { readonly code: string; readonly text: string }[],
): boolean {
  return warnings.some(warning => WATCHED_WARNINGS.has(warning.code) && revealHidden(warning.text).includes(path));
}

export function holdsMarker(text: string): boolean {
  return new RegExp(MARKER.source, 'u').test(text);
}

/** A whole file of a skill, or one other line the review lists. */
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
    };

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length);

/** Entries in the order the daemon gave them (SKILL.md first), each as a file or a line. */
export function reviewRows(entries: readonly SkillReviewEntry[]): readonly ReviewRow[] {
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
    return { kind: 'line', label, text, marked };
  });
}

/** The heading over the files a copy brings. */
export const REVIEW_HEADING = 'What this brings, in full';

// ── Warnings ─────────────────────────────────────────────────────────────────────────────────────

export type WarningTone = 'danger' | 'caution' | 'note';

interface WarningWords {
  readonly label: string;
  readonly tone: WarningTone;
  /** Lower comes first. The older version leads, because it is the one a person must not skim past. */
  readonly rank: number;
}

const WARNING_WORDS: Readonly<Record<SkillInstallWarningCode, WarningWords>> = {
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
  readonly code: SkillInstallWarningCode;
  /** A short name for the kind of warning, so it never rests on colour alone. */
  readonly label: string;
  /** The daemon's own sentence, unchanged. */
  readonly text: string;
  readonly tone: WarningTone;
}

/** Every warning, the most serious first; ties keep the daemon's order. */
export function warningRows(warnings: readonly SkillInstallWarning[]): readonly WarningRow[] {
  return warnings
    .map((warning, index) => ({ warning, index, words: WARNING_WORDS[warning.code] }))
    .toSorted((left, right) => left.words.rank - right.words.rank || left.index - right.index)
    .map(({ warning, words }) => ({ code: warning.code, label: words.label, text: warning.text, tone: words.tone }));
}
