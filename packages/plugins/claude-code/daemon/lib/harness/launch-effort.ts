/**
 * The reasoning level a ferret was LAUNCHED with, decided before Claude Code has said anything.
 *
 * A brand-new ferret has no transcript, so nothing the harness reports about itself exists yet — and the
 * composer had nothing to put on its effort chip but a bare `effort`. The level is not a mystery at that
 * moment, though: either the start request named one, or the home's own `settings.json` holds the level the
 * harness will start on, because that file is where Claude Code persists the choice (`/effort` writes
 * `effortLevel`).
 *
 * THIS IS A LAUNCH FACT, NOT AN OBSERVATION. A surface prefers anything the harness later reports over it.
 * When neither the request nor the file names a level the answer is absent, which a surface reads as "the
 * harness's own default" — never as a level somebody chose.
 *
 * PURE: the caller reads the file; this only reads the text it was handed, and an unreadable or malformed
 * document is no evidence rather than an error, because a launch must never fail on it.
 */

/** The file under a ferret's home that holds its persisted reasoning level. */
export const SETTINGS_FILE = 'settings.json';

/** A level as the harness would accept it: a short word, never prose or a blank. */
const LEVEL = /^[a-z][a-z-]{0,23}$/u;

/**
 * A level as it is spelled on the command and recorded on the document: trimmed, lowercased, and only when it
 * is a short word. ONE normaliser, so the level a launch carries and the level the ferret records can never
 * differ; anything it rejects is no level at all.
 */
export const reasoningLevel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return LEVEL.test(trimmed) ? trimmed : undefined;
};

function settingsDocument(document: string | undefined): Record<string, unknown> | undefined {
  if (document === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(document);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The level `settings.json` holds (`effortLevel`), or `undefined` when it names none. */
export function persistedReasoningEffort(document: string | undefined): string | undefined {
  return reasoningLevel(settingsDocument(document)?.effortLevel);
}

/** Whether `settings.json` has saved fast mode on or off (`fastMode`, which `/fast on` and `/fast off` write). */
export function persistedFast(document: string | undefined): boolean | undefined {
  const value = settingsDocument(document)?.fastMode;
  return typeof value === 'boolean' ? value : undefined;
}

/** The level this launch starts on: the request's, else the home's persisted one, else none. */
export function launchReasoningEffort(
  requested: string | undefined,
  persisted: string | undefined,
): string | undefined {
  return reasoningLevel(requested) ?? persisted;
}
