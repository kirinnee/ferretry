import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  GUARDED_HARNESS_NAMES,
  RealHarnessRefusedError,
  realHarnessInstall,
  type TmuxLaunch,
  type TmuxLaunchGuard,
} from '../../lib/tmux/index.ts';

/** Finds a bare command name on a colon-separated search path, as the pane's shell would. */
export type CommandLocator = (name: string, searchPath: string) => string | undefined;

const locateOnPath: CommandLocator = (name, searchPath) => Bun.which(name, { PATH: searchPath }) ?? undefined;

/**
 * Refuses a launch that would reach the owner's real Claude Code or Codex.
 *
 * WHAT IT RESOLVES. The pane's own program, and both harness names on the PATH the pane will see. A
 * generated runtime wrapper ends in `exec claude` — by NAME — so checking only the wrapper would pass
 * every launch, and the leaked session that motivated this guard was exactly a fake-looking wrapper
 * whose `claude` was the real one. The pane's PATH is the launch's own `PATH` when it carries one and
 * otherwise this daemon's, because the tmux server the daemon starts inherits the daemon's.
 *
 * Every path is compared after symlinks are resolved and before, so a profile link and the store path
 * it points into are both recognised.
 */
export class RealHarnessLaunchGuard implements TmuxLaunchGuard {
  constructor(
    private readonly daemonSearchPath: () => string | undefined,
    private readonly locate: CommandLocator = locateOnPath,
  ) {}

  async check(launch: TmuxLaunch): Promise<void> {
    const searchPath = launch.env?.PATH ?? this.daemonSearchPath() ?? '';
    const [program] = launch.command;
    const candidates: { readonly name: string; readonly path: string | undefined }[] = [
      {
        name: program,
        path: program.includes('/')
          ? isAbsolute(program)
            ? program
            : resolve(launch.cwd, program)
          : this.locate(program, searchPath),
      },
      ...GUARDED_HARNESS_NAMES.map(name => ({ name, path: this.locate(name, searchPath) })),
    ];
    for (const candidate of candidates) {
      if (candidate.path === undefined) continue;
      const resolved = await realpath(candidate.path).catch(() => candidate.path as string);
      const install = realHarnessInstall(resolved) ?? realHarnessInstall(candidate.path);
      if (install !== undefined) throw new RealHarnessRefusedError(candidate.name, resolved, install);
    }
  }
}
