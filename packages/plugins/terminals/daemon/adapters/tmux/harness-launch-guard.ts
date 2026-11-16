import { locateCommand, realpath } from '../host/fs.ts';
import { isAbsolute, resolve } from 'node:path';
import type { ChildEnvironment, HandleCommandLookup } from '@ferretry/kernel/contract';
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

/** Where a bare command resolves on the PATH an opaque environment handle will set (`kernel.paths.whichFor`). */
export type HandleCommandLocator = (name: string, env: ChildEnvironment) => Promise<HandleCommandLookup>;

/**
 * Refuses a launch that would reach the owner's real Claude Code or Codex.
 *
 * WHAT IT RESOLVES. The pane's own program, and both harness names on the PATH the pane will see. A
 * generated runtime wrapper ends in `exec claude` — by NAME — so checking only the wrapper would pass
 * every launch, and the leaked session that motivated this guard was exactly a fake-looking wrapper
 * whose `claude` was the real one. The pane's PATH is the launch's own `PATH` when it carries one and
 * otherwise this daemon's, because the tmux server the daemon starts inherits the daemon's.
 *
 * A LAUNCH WHOSE OPAQUE ENVIRONMENT HANDLE SETS `PATH` (`envNames`; the value never reaches this plugin, so every
 * ferret with a Shells launch part) is searched through `kernel.paths.whichFor`: each name is resolved on the PATH the
 * handle WILL set, and on nothing else (the daemon's own PATH is not what the pane sees), without opening or spending
 * the handle. The kernel hands back a path, never the PATH, and the located path is judged exactly as above.
 *
 * IT FAILS CLOSED when it cannot make that search: a handle that sets `PATH` when no handle (or no `whichFor`) was
 * handed, a handle whose PATH the kernel cannot prove (a secret-derived, foreign, spent or unreadable one, an answer of
 * `unprovable`, or a `whichFor` that throws), or no search path at all. Either way the pane could reach a `claude` the
 * guard never looked at, so the launch is refused rather than passed (`UnprovableHarnessError`).
 *
 * Every path is compared after symlinks are resolved and before, so a profile link and the store path
 * it points into are both recognised.
 */
export class RealHarnessLaunchGuard implements TmuxLaunchGuard {
  constructor(
    /** The daemon's `PATH` as the kernel's launch-guard fact names it (`hostFacts.launchGuard().searchPath`). */
    private readonly daemonSearchPath: () => string | undefined,
    private readonly locate: CommandLocator = locateCommand,
    /** `kernel.paths.whichFor`: absent, a launch whose handle sets PATH cannot be proved and is refused. */
    private readonly whichFor?: HandleCommandLocator,
  ) {}

  async check(launch: TmuxLaunch): Promise<void> {
    const [program] = launch.command;
    const ownPath = launch.env?.PATH;
    const handlePath = ownPath === undefined && launch.envNames?.includes('PATH') === true;
    let find: (name: string) => Promise<string | undefined>;
    if (handlePath) {
      const handle = launch.handle;
      const whichFor = this.whichFor;
      if (handle === undefined || whichFor === undefined) throw new UnprovableHarnessError('own-path');
      find = async name => {
        const answer = await whichFor(name, handle).catch((): HandleCommandLookup => ({ kind: 'unprovable' }));
        if (answer.kind === 'unprovable') throw new UnprovableHarnessError('own-path');
        return answer.kind === 'found' ? answer.path : undefined;
      };
    } else {
      const searchPath = ownPath ?? this.daemonSearchPath();
      if (searchPath === undefined || searchPath === '') throw new UnprovableHarnessError('no-path');
      find = async name => this.locate(name, searchPath);
    }
    const candidates: { readonly name: string; readonly path: string | undefined }[] = [
      {
        name: program,
        path: program.includes('/')
          ? isAbsolute(program)
            ? program
            : resolve(launch.cwd, program)
          : await find(program),
      },
    ];
    for (const name of GUARDED_HARNESS_NAMES) candidates.push({ name, path: await find(name) });
    for (const candidate of candidates) {
      if (candidate.path === undefined) continue;
      const resolved = await realpath(candidate.path).catch(() => candidate.path as string);
      const install = realHarnessInstall(resolved) ?? realHarnessInstall(candidate.path);
      if (install !== undefined) throw new RealHarnessRefusedError(candidate.name, resolved, install);
    }
  }
}
