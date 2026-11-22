/**
 * The setup scan's command lookup: the daemon's `PATH` first (as for every command), and for `claude` and `codex` ONLY,
 * the folders their installers write to when `PATH` found nothing (`../../contract/harness-fallback.ts`, the one list the
 * Claude Code and Codex onboarding lookups use too). A tool installed after the daemon's `PATH` was captured, into a
 * folder that `PATH` never listed, is then found without a restart, and removed, is gone at the next lookup.
 *
 * The kernel's own lookup searches the caller's `directories` first and `PATH` second; that is the same answer here
 * because `PATH` has just missed, so PATH keeps its precedence.
 */
import { HARNESS_FALLBACK_COMMANDS, harnessFallbackDirectories } from '../../contract/index.ts';
import type { HostPlatform } from './host-platform.ts';

export interface HarnessLookupDeps {
  /** `kernel.paths.which`. */
  readonly which: (name: string, options?: { readonly directories?: readonly string[] }) => Promise<string | undefined>;
  /** The person's home folder. */
  readonly home: () => string;
  readonly platform: Pick<HostPlatform, 'name' | 'prime'>;
}

export function harnessAwareWhich(deps: HarnessLookupDeps): (name: string) => Promise<string | undefined> {
  return async name => {
    const onPath = await deps.which(name);
    if (onPath !== undefined || !HARNESS_FALLBACK_COMMANDS.includes(name)) return onPath;
    await deps.platform.prime();
    return await deps.which(name, {
      directories: harnessFallbackDirectories({ home: deps.home(), platform: deps.platform.name() }),
    });
  };
}
