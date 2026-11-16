/**
 * The kernel's own refusal codes. Each is `{ error: <sentence>, code }` through `errorResponse`.
 *
 * - `plugin_unavailable` (503): a SKELETON half (listed in `ports-pending.json`) answering a declared route, socket,
 *   tool or provide key. Day-1 only; a released build has none.
 * - `plugin_failed` (503): the plugin's `build` threw; its decide hooks say no, its provide keys are unavailable.
 * - `plugin_off` (404 as an unrouted path): never sent; an off plugin's routes are simply not in the table.
 * - `store_damaged` (503): the subsystem's state could not be read; it names the file (§9.3).
 * - `plugin_paused`: CLIENT-side only, never on the wire: the generated client blocked a call because the daemon's
 *   inventory entry is missing, off or has another contract hash (§9.6).
 */
export const KERNEL_REFUSALS = {
  pluginUnavailable: { status: 503, code: 'plugin_unavailable' },
  pluginFailed: { status: 503, code: 'plugin_failed' },
  storeDamaged: { status: 503, code: 'store_damaged' },
  pluginPaused: { status: 0, code: 'plugin_paused' },
} as const;

export type KernelRefusalCode = (typeof KERNEL_REFUSALS)[keyof typeof KERNEL_REFUSALS]['code'];

export function skeletonSentence(title: string): string {
  return `${title} is not built yet in this version of Ferretry.`;
}
