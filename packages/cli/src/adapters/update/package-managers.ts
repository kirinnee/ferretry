import type { CommandOutcome } from '../../lib/daemon/ports.ts';
import { plainLine } from '../../lib/progress/index.ts';
import type { UpdateObserver, UpdatePhase } from '../../lib/update/activity.ts';
import { NixProgressTracker } from '../../lib/update/nix-progress.ts';
import type { IPackageManagerPort } from '../../lib/update/ports.ts';

/** The experimental features every `nix profile` command needs, named so no host's config decides. */
const NIX = ['nix', '--extra-experimental-features', 'nix-command flakes'] as const;

/** Makes nix describe what it is doing as events instead of a redrawn terminal line. */
const NIX_EVENTS = ['--log-format', 'internal-json', '-v'] as const;

/** Runs a command to the end, handing each line of its output to `onLine` as it appears. */
export type RunCommand = (argv: readonly string[], onLine?: (line: string) => void) => Promise<CommandOutcome>;

/**
 * The package-manager commands a self-update runs, as the user, never with `sudo`.
 *
 * `--refresh` on the nix commands is the difference between an update and a no-op: an unlocked
 * `github:` reference is cached for an hour, so without it `nix profile upgrade` reinstalls the
 * version it already has and reports success.
 *
 * With an observer, a command's output is read as it happens and reported as what it means: nix is
 * asked for its activity events, brew's last line is the detail. The returned outcome is the same
 * either way, down to a failed nix command's `stderr` being its messages in words rather than events.
 */
export class CommandPackageManagers implements IPackageManagerPort {
  constructor(private readonly run: RunCommand) {}

  /** Make brew see the newest cask: tap it if it is gone, then `brew update`. Auto-update may not have run for a day. */
  async brewRefresh(tap: string, url: string, observer?: UpdateObserver): Promise<CommandOutcome> {
    const tapped = await this.run(['brew', 'tap']);
    if (tapped.code === 0 && !tapped.stdout.split('\n').some(line => line.trim() === tap)) {
      const added = await this.#brew(['brew', 'tap', tap, url], 'refreshing', observer);
      if (added.code !== 0) return added;
    }
    return this.#brew(['brew', 'update'], 'refreshing', observer);
  }

  brewUpgrade(cask: string, observer?: UpdateObserver): Promise<CommandOutcome> {
    return this.#brew(['brew', 'upgrade', '--cask', cask], 'upgrading', observer);
  }

  nixProfileUpgrade(element: string, observer?: UpdateObserver): Promise<CommandOutcome> {
    return this.#nix(['profile', 'upgrade', '--refresh'], element, observer);
  }

  nixProfileRollback(): Promise<CommandOutcome> {
    return this.run([...NIX, 'profile', 'rollback']);
  }

  nixProfileInstall(flake: string, observer?: UpdateObserver): Promise<CommandOutcome> {
    return this.#nix(['profile', 'install', '--refresh'], flake, observer);
  }

  #brew(argv: readonly string[], phase: UpdatePhase, observer: UpdateObserver | undefined): Promise<CommandOutcome> {
    if (observer === undefined) return this.run(argv);
    observer({ phase });
    return this.run(argv, raw => {
      const line = plainLine(raw);
      if (line !== '') observer({ phase, line });
    });
  }

  async #nix(verb: readonly string[], target: string, observer: UpdateObserver | undefined): Promise<CommandOutcome> {
    if (observer === undefined) return this.run([...NIX, ...verb, target]);
    const tracker = new NixProgressTracker();
    observer(tracker.activity());
    const outcome = await this.run([...NIX, ...verb, ...NIX_EVENTS, target], line => {
      const activity = tracker.feed(line);
      if (activity !== undefined) observer(activity);
    });
    return { ...outcome, stderr: nixMessages(outcome.stderr) };
  }
}

/** A nix run's stderr said in words: its messages and plain lines, with the activity events taken out. */
function nixMessages(stderr: string): string {
  const reader = new NixProgressTracker();
  for (const line of stderr.split('\n')) reader.feed(line);
  return reader.messages.join('\n');
}
