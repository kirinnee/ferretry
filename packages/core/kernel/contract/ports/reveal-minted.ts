/**
 * The security allow-list for `permissions.revealMinted`, the Vault's one getter (docs/secrets.md › The one exception):
 * the plugin ids that may read back a secret they minted. A manifest cannot extend it; the build and the boot refuse any
 * other plugin that declares the flag, and the Vault hands the getter to no id outside it.
 */
export const REVEAL_MINTED_PLUGINS = ['mcp'] as const;
