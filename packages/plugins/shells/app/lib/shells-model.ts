/** Pure helpers for the Shells tab: the words on screen and the request a form makes. No React, no daemon. */
import type { ShellAddRequest, ShellBuildState, ShellSummary } from '../../contract/index.ts';
import { ShellNameSchema } from '../../contract/index.ts';

export const BUILD_WORDS: Readonly<Record<ShellBuildState, string>> = {
  'not-built': 'Not built',
  building: 'Building',
  built: 'Built',
  failed: 'Build failed',
};

export type BuildTone = 'ok' | 'warn' | 'err' | 'pend';
export const BUILD_TONES: Readonly<Record<ShellBuildState, BuildTone>> = {
  'not-built': 'pend',
  building: 'warn',
  built: 'ok',
  failed: 'err',
};

/** One line under a shell's name: what it is, whether it is pinned, and who uses it. */
export function shellLine(shell: ShellSummary): string {
  const source = shell.kind === 'flake' ? 'Flake reference' : 'Package list';
  const pin = shell.locked ? (shell.floating ? 'locked, floating' : 'locked') : 'not locked';
  const used = shell.usedBy.length === 0 ? 'used by nothing yet' : `used by ${shell.usedBy.join(', ')}`;
  return `${source} · ${pin} · ${used}`;
}

export interface AddDraft {
  readonly name: string;
  readonly kind: 'flake' | 'packages';
  /** A flake reference, or package names separated by spaces or commas. */
  readonly source: string;
  readonly floating: boolean;
}

export const EMPTY_DRAFT: AddDraft = { name: '', kind: 'packages', source: '', floating: false };

export const packageNames = (text: string): readonly string[] =>
  text
    .split(/[\s,]+/u)
    .map(part => part.trim())
    .filter(part => part !== '');

/** The request a draft makes, or the sentence that says what is missing. */
export function addRequestOf(draft: AddDraft): { ok: true; request: ShellAddRequest } | { ok: false; why: string } {
  const name = ShellNameSchema.safeParse(draft.name.trim());
  if (!name.success)
    return { ok: false, why: 'Name it with lowercase letters, digits and dashes, starting with a letter.' };
  if (draft.kind === 'flake') {
    const flake = draft.source.trim();
    if (flake === '') return { ok: false, why: 'Say which flake reference to use.' };
    return { ok: true, request: { name: name.data, item: { flake, floating: draft.floating } } };
  }
  const packages = [...packageNames(draft.source)];
  if (packages.length === 0) return { ok: false, why: 'List at least one package.' };
  return { ok: true, request: { name: name.data, item: { packages, floating: false } } };
}
