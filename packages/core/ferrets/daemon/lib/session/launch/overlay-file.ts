/**
 * Preparing a launch whose Claude overlay carries the login's environment.
 *
 * {@link buildLaunchArgv} is pure and never inlines such an overlay (a credential must not reach `ps`, the pane's
 * command line or the session document's `command`), so a launch that needs one first has its per-launch file
 * written through this port, then names only the file's PATH. Every caller that builds an argv goes through
 * {@link prepareLaunchArgv}, so the four of them (a start, an adoption, a revive and a migration) cannot disagree.
 */

import { buildLaunchArgv, FixedSettingsUnreadableError, type LaunchArgvParts, launchOverlayFile } from './argv.ts';
import type { LaunchOverlayFile } from './argv.ts';

/** Where per-launch settings files live. The adapter owns the directory, its mode and its sweep. */
export interface LaunchOverlayFiles {
  /**
   * The absolute path the file lives at, with its content written (privately and atomically) when `write` is set:
   * a launch writes it, a stale-settings read only asks where it would be. Nothing when there is nowhere to put one.
   */
  place(file: LaunchOverlayFile, options: { readonly write: boolean }): Promise<string | undefined>;
}

/**
 * The launch argv, with its per-launch overlay file written first when the overlay carries an environment.
 *
 * Without a port such an overlay is refused ({@link LaunchOverlayFileRequiredError}), never inlined. A file that
 * cannot be placed refuses the same way: {@link FixedSettingsUnreadableError}, which every caller already handles.
 */
export async function prepareLaunchArgv(
  parts: LaunchArgvParts,
  files: LaunchOverlayFiles | undefined,
  options: { readonly write: boolean } = { write: true },
): Promise<readonly string[]> {
  const file = launchOverlayFile(parts.harness, { fast: parts.fast, compactAt: parts.compactAt }, parts.fixedSettings);
  if (file === undefined || files === undefined) return buildLaunchArgv(parts);
  const overlayFile = await files.place(file, options).catch(() => undefined);
  if (overlayFile === undefined)
    throw new FixedSettingsUnreadableError(
      'the per-launch settings file for this login’s environment could not be written, so fast mode or a compaction trigger cannot be applied',
    );
  return buildLaunchArgv({ ...parts, overlayFile });
}
