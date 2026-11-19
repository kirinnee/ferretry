/**
 * The words the import wizard says: what each thing it found BECOMES in Ferretry, and what it leaves where it is. One place,
 * so the screen, the tests and the owner's reading of it agree.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { ImportNamedItem, ImportSingleItem } from '../../../contract/index.ts';

export const HARNESS_LABEL: Readonly<Record<HarnessKey, string>> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** What one item becomes, by kind and harness. */
export const becomes = (harness: HarnessKey, kind: ImportSingleItem | ImportNamedItem): string => {
  switch (kind) {
    case 'instructions':
      return 'Instructions in your Default profile';
    case 'mcp':
      return 'MCP server';
    case 'skill':
      return 'Skill';
    case 'settings':
      return harness === 'claude-code' ? 'Claude settings' : 'Codex settings';
    case 'env':
      return 'This login’s environment';
    case 'profile':
      return 'A Codex settings item: its model and effort only';
  }
};

/** Said under a secret-looking key: it is moved, never shown. */
export const SECRET_KEPT = 'kept in the Vault: agents use it, nobody can read it back';

export const HOOKS_NOT_IMPORTED = 'Not imported: Ferretry doesn’t use hooks';
export const PROJECT_INSTRUCTIONS_STAY = 'Stay in each project; agents read them there';
export const CONVERSATIONS_LINE = 'Conversations: already read automatically, one way. Nothing to import.';

export const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** The header's sentence about the tool itself. */
export const toolHeadline = (input: {
  readonly installed: boolean;
  readonly version: string | null;
  readonly signedInAs: 'unknown' | 'none' | { readonly email: string | null };
}): string => {
  if (!input.installed) return 'Not installed on this machine';
  const version = input.version === null ? 'Installed' : `Installed · version ${input.version}`;
  if (input.signedInAs === 'unknown') return version;
  if (input.signedInAs === 'none') return `${version} · not signed in`;
  return `${version} · signed in${input.signedInAs.email === null ? '' : ` as ${input.signedInAs.email}`}`;
};
