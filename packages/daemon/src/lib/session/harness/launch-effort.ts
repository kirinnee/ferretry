/**
 * The reasoning level a session was LAUNCHED with, decided before its harness has said anything.
 *
 * A brand-new session has no transcript, so nothing the harness reports about itself exists yet —
 * and the composer had nothing to put on its effort chip but a bare `effort`. The level is not a
 * mystery at that moment, though: either the start request named one, or the runtime's own settings
 * file holds the level its harness will start on, because that file is where each harness persists
 * the choice (`/effort` writes Claude's `effortLevel`; Codex reads `model_reasoning_effort`).
 *
 * THIS IS A LAUNCH FACT, NOT AN OBSERVATION. It is recorded on the session's configuration beside
 * the model it was launched with, and a surface prefers anything the harness later reports over it.
 * When neither the request nor the file names a level the answer is absent, which a surface reads as
 * "the harness's own default" — never as a level somebody chose.
 *
 * PURE: the caller reads the file; this only reads the text it was handed, and an unreadable or
 * malformed document is no evidence rather than an error, because a launch must never fail on it.
 */

import type { HarnessKind } from '../../core/inventory.ts';

/** The file under a runtime's home that holds its persisted reasoning level. */
export const RUNTIME_SETTINGS_FILE: Readonly<Record<HarnessKind, string>> = {
  claude: 'settings.json',
  codex: 'config.toml',
};

/** A level as a harness would accept it: a short word, never prose or a blank. */
const LEVEL = /^[a-z][a-z-]{0,23}$/u;

const level = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return LEVEL.test(trimmed) ? trimmed : undefined;
};

/** Claude's `settings.json` `effortLevel`. */
function claudeLevel(document: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(document);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return level((parsed as Record<string, unknown>).effortLevel);
  } catch {
    return undefined;
  }
}

/**
 * Codex's top-level `model_reasoning_effort`.
 *
 * Only the ROOT table counts: the same key under `[profiles.x]` belongs to a profile this launch did
 * not select, so reading stops at the first table header.
 */
function codexLevel(document: string): string | undefined {
  for (const line of document.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) return undefined;
    const match = /^model_reasoning_effort\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/u.exec(trimmed);
    if (match !== null) return level(match[1] ?? match[2]);
  }
  return undefined;
}

/** The level a runtime's settings document holds, or `undefined` when it names none. */
export function persistedReasoningEffort(harness: HarnessKind, document: string | undefined): string | undefined {
  if (document === undefined) return undefined;
  return harness === 'claude' ? claudeLevel(document) : codexLevel(document);
}

/** Claude's `settings.json` `fastMode`, which `/fast on` and `/fast off` write. */
function claudeFast(document: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(document);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>).fastMode;
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Codex's top-level `service_tier`, which `/fast` writes: `fast` (or the `priority` id it maps to) is
 * on and `default` is off. Any other tier is neither, and a missing key means the model's own default
 * — which is not knowable from this file, so it is not an answer.
 */
function codexFast(document: string): boolean | undefined {
  for (const line of document.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) return undefined;
    const match = /^service_tier\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/u.exec(trimmed);
    if (match === null) continue;
    const tier = (match[1] ?? match[2] ?? '').trim().toLowerCase();
    return tier === 'fast' || tier === 'priority' ? true : tier === 'default' ? false : undefined;
  }
  return undefined;
}

/** Whether a runtime's settings document has saved fast mode on or off, or `undefined` when it has not said. */
export function persistedFast(harness: HarnessKind, document: string | undefined): boolean | undefined {
  if (document === undefined) return undefined;
  return harness === 'claude' ? claudeFast(document) : codexFast(document);
}

/** The level this launch starts on: the request's, else the runtime's persisted one, else none. */
export function launchReasoningEffort(
  requested: string | undefined,
  persisted: string | undefined,
): string | undefined {
  return level(requested) ?? persisted;
}
