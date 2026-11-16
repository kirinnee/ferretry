/**
 * The seam to YAML text editing. `packs.yaml` is edited by people, so a save changes only the keys that differ and leaves
 * the owner's comments and key order byte for byte; that is done by the `yaml` document API, which this half does not
 * depend on (PENDING.md). The shell hands the real editor in; a test hands the kernel's own (the same code).
 */

/** What a parsed file means: its plain value, or that it does not parse. */
type ConfigRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

export interface ConfigText {
  /** Parse one file; `ok: false` for text that is not YAML. */
  read(text: string): ConfigRead;
  /**
   * `text` with `target` written over it, changing a key only where the value really differs. `current` is what the text
   * means now; `modeline` is the `# yaml-language-server` line a file starts with.
   */
  edit(text: string, target: Record<string, unknown>, current: unknown, modeline: string | undefined): string;
}
