import type { CompactAt } from '@ferretry/protocol';
import { FixedSettingsUnreadableError, type LaunchArgvParts } from './argv.ts';
import { currentLaunchCompactAt } from './current.ts';
import { type LaunchOverlayFiles, prepareLaunchArgv } from './overlay-file.ts';

export type AdoptedLaunch =
  | { readonly kind: 'argv'; readonly argv: readonly string[] }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * The first launch of an adopted conversation: the resume argv plus, like every other launch, the login's default
 * compaction trigger (docs/compact-at.md). Claude carries it in a replacement `--settings`, so that login's fixed
 * overlay is read first; one that cannot be read refuses the adoption rather than launching without the trigger.
 */
export async function adoptedLaunchArgv(input: {
  readonly parts: Omit<LaunchArgvParts, 'compactAt' | 'fixedSettings' | 'fast'>;
  readonly accountDefault: CompactAt | undefined;
  readonly window: number | undefined;
  readonly fixedSettings: (executable: string, harness: LaunchArgvParts['harness']) => Promise<string | undefined>;
  /** Where a login that pins its environment gets its per-launch settings file; see {@link prepareLaunchArgv}. */
  readonly overlayFiles?: LaunchOverlayFiles;
}): Promise<AdoptedLaunch> {
  const { parts } = input;
  const compactAt = currentLaunchCompactAt({}, input.accountDefault, input.window);
  const overlay =
    parts.harness === 'claude' && compactAt !== undefined
      ? await input.fixedSettings(parts.executable, parts.harness)
      : '';
  const unreadable = {
    kind: 'unreadable',
    reason: 'the login’s fixed settings could not be read, so its compaction trigger cannot be applied',
  } as const;
  if (overlay === undefined) return unreadable;
  try {
    return {
      kind: 'argv',
      argv: await prepareLaunchArgv(
        { ...parts, ...(compactAt === undefined ? {} : { compactAt, fixedSettings: overlay }) },
        input.overlayFiles,
      ),
    };
  } catch (error) {
    if (error instanceof FixedSettingsUnreadableError) return unreadable;
    throw error;
  }
}
