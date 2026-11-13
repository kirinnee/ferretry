import { locateCommand, realpath } from '../host/fs.ts';
import { isAbsolute, resolve } from 'node:path';
import {
  GUARDED_HARNESS_NAMES,
  RealHarnessRefusedError,
  realHarnessInstall,
  UnprovableHarnessError,
  type TmuxLaunch,
  type TmuxLaunchGuard,
} from '../../lib/tmux/index.ts';

/** Finds a bare command name on a colon-separated search path, as the pane's shell would. */
export type CommandLocator = (name: string, searchPath: string) => string | undefined;

/**
 * Refuses a launch that would reach the owner's real Claude Code or Codex.
 *
 * WHAT IT RESOLVES. The pane's own program, and both harness names on the PATH the pane will see. A
 * generated runtime wrapper ends in `exec claude` — by NAME — so checking only the wrapper would pass
 * every launch, and the leaked session that motivated this guard was exactly a fake-looking wrapper
 * whose `claude` was the real one. The pane's PATH is the launch's own `PATH` when it carries one and
 * otherwise this daemon's, because the tmux server the daemon starts inherits the daemon's.
 *
 * IT FAILS CLOSED when it cannot make that search: a launch whose opaque environment handle sets `PATH`
 * (`envNames`; the value never reaches this plugin), or no search path at all. Either way the pane could reach a
 * `claude` the guard never looked at, so the launch is refused rather than passed (`UnprovableHarnessError`).
 *
 * DECLARED DIFFERENCE FROM TODAY: today searched a launch's PATH by value, so a shell PATH holding no real
 * `claude` passed. 5.0 cannot read the handle, so every armed launch whose handle names `PATH` is refused —
 * that is every ferret with a Shells launch part, since Shells always sets PATH — and so is a launch with no
 * search path at all, where today searched `''` and passed. Both fail closed (409 `real_harness`). Judging
 * such a launch on its real PATH waits for a kernel/Vault-side resolve (GAP in `ports-pending.json`).
 *
 * Every path is compared after symlinks are resolved and before, so a profile link and the store path
 * it points into are both recognised.
 */
export class RealHarnessLaunchGuard implements TmuxLaunchGuard {
  constructor(
    /** The daemon's `PATH` as the kernel's launch-guard fact names it (`hostFacts.launchGuard().searchPath`). */
    private readonly daemonSearchPath: () => string | undefined,
    private readonly locate: CommandLocator = locateCommand,
  ) {}

  async check(launch: TmuxLaunch): Promise<void> {
    const ownPath = launch.env?.PATH;
    if (ownPath === undefined && launch.envNames?.includes('PATH') === true)
      throw new UnprovableHarnessError('own-path');
    const searchPath = ownPath ?? this.daemonSearchPath();
    if (searchPath === undefined || searchPath === '') throw new UnprovableHarnessError('no-path');
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
