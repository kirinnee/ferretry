import type { KitExtras, RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';

/**
 * What only some harnesses' runtimes have beyond the common launch: Claude has nothing. It says so (an empty answer) rather than
 * leaving the member out, because a kit with no answer at all is one Runtimes refuses by name.
 */
const runtimeExtras = (): KitExtras => ({ env: {} });

export const claudeExtrasKit: RuntimesHarnessKit = { runtimeExtras };
