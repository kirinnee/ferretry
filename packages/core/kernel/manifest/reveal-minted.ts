import { REVEAL_MINTED_PLUGINS } from '../contract/ports/reveal-minted.ts';
import type { Manifest } from './types.ts';

/** Checked at declaration and at boot: only an allow-listed plugin may be handed the Vault's one getter. */
export function revealMintedProblems(manifest: Manifest): readonly string[] {
  if (manifest.permissions?.revealMinted !== true) return [];
  return (REVEAL_MINTED_PLUGINS as readonly string[]).includes(manifest.id)
    ? []
    : [`plugin ${manifest.id}: permissions.revealMinted is not allowed`];
}
