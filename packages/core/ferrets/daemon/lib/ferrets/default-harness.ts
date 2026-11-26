import type { HarnessKey } from '../../../contract/index.ts';

/** The harness a start that names no runtime, login or harness launches on: Claude Code, as it always was. */
const DEFAULT_HARNESS: HarnessKey = 'claude-code';

/**
 * The ONE rule for which harness an unqualified start picks. It names Claude Code explicitly, so turning another harness
 * plugin on (whatever order the plugin graph registers them in) never changes it. Only a machine with no Claude Code
 * harness installed falls to the first registered one; none registered is `undefined`.
 */
export const defaultHarnessKey = (installed: readonly HarnessKey[]): HarnessKey | undefined =>
  installed.includes(DEFAULT_HARNESS) ? DEFAULT_HARNESS : installed[0];
