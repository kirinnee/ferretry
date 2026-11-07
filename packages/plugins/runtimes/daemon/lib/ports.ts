/**
 * The narrow interfaces this library codes against where it would otherwise touch the host. Pure code takes one of
 * these as a parameter; the daemon half's adapters build it from the injected kernel ports. Nothing here names
 * `node:fs`, a clock global or the environment (banned-globals).
 */

// ─── config text (GAP(kernel): the kernel's config-text helpers are host-private; a plugin cannot import them) ────

/** The settings documents a Clone merges key by key, as the files they are on this machine. */
export type SettingsFile = 'warden.yaml' | 'learning.yaml' | 'voice.yaml';

/** A file read as YAML: its plain value, or why it did not parse. */
export type ConfigTextRead =
  | { readonly ok: true; readonly read: { readonly value: unknown } }
  | { readonly ok: false; readonly errors: readonly { readonly message: string }[] };

/**
 * What the settings merge needs from the config layer: read a YAML text, edit one keeping its comments, spot a raw
 * secret, judge what taking a text would loosen against what is in effect, and the schema modeline a file carries.
 */
export interface ConfigText {
  read(text: string): ConfigTextRead;
  /** The text of a file after it is made to mean `target`; `existing` is `undefined` for a new file. */
  edit(existing: string | undefined, target: Record<string, unknown>, current: unknown, modeline: string): string;
  /** Whether `document` holds a string that looks like a raw secret. */
  hasRawSecret(document: unknown): boolean;
  /**
   * The sentences taking `text` as the `path` file would loosen against `effective`, or `undefined` when the text
   * cannot be judged (it does not pass the file's schema).
   */
  loosening(path: SettingsFile, effective: unknown, text: string): readonly string[] | undefined;
  /** The `# yaml-language-server: $schema=…` line the `path` file starts with. */
  modeline(path: SettingsFile): string;
}
