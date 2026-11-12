import { ProtocolVersionSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { CommandOutcome } from '../../lib/daemon/ports.ts';
import { plainLine } from '../../lib/progress/index.ts';
import type { UpdateObserver, UpdatePhase } from '../../lib/update/activity.ts';
import { NixProgressTracker } from '../../lib/update/nix-progress.ts';
import type { IPackageManagerPort, LockedNixTarget, PackageVersion } from '../../lib/update/ports.ts';

/** The experimental features every `nix profile` command needs, named so no host's config decides. */
const NIX = ['nix', '--extra-experimental-features', 'nix-command flakes'] as const;

/** Makes nix describe what it is doing as events instead of a redrawn terminal line. */
const NIX_EVENTS = ['--log-format', 'internal-json', '-v'] as const;

/** Runs a command to the end, handing each line of its output to `onLine` as it appears. */
export type RunCommand = (argv: readonly string[], onLine?: (line: string) => void) => Promise<CommandOutcome>;

/**
 * The package-manager commands a self-update runs, as the user, never with `sudo`.
 *
 * Refresh only while resolving an immutable target. The later installation binds the original
 * install command names only that exact revision. Profile replacements stage it below the old
 * element's precedence, so rollback restores the old executable with one generation change.
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

  async brewCaskVersion(cask: string): Promise<PackageVersion> {
    const answer = await this.run(['env', 'HOMEBREW_NO_AUTO_UPDATE=1', 'brew', 'info', '--cask', '--json=v2', cask]);
    try {
      const data = z
        .object({ casks: z.array(z.object({ full_token: z.string(), version: ProtocolVersionSchema })).length(1) })
        .parse(JSON.parse(answer.stdout));
      const found = data.casks[0];
      if (answer.code === 0 && found?.full_token === cask) return { version: found.version };
    } catch {
      /* A failed or malformed source check always refuses. */
    }
    return { failure: `could not learn the local Homebrew cask version for ${cask}` };
  }

  async nixResolve(flake: string, element?: string): Promise<LockedNixTarget | { readonly failure: string }> {
    try {
      let source = flake;
      let profileTarget: LockedNixTarget['profile'];
      if (element !== undefined) {
        const listed = await this.run([...NIX, 'profile', 'list', '--json']);
        if (listed.code !== 0) return { failure: 'could not read the Nix profile source' };
        const entrySchema = z.object({
          originalUrl: z.string(),
          attrPath: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
          priority: z.number().int().min(-2147483648).max(2147483646).default(5),
        });
        const profile = z
          .object({ elements: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]) })
          .parse(JSON.parse(listed.stdout));
        const entry = Array.isArray(profile.elements) ? profile.elements[Number(element)] : profile.elements[element];
        if (entry === undefined) return { failure: 'could not find the Nix profile element' };
        const parsed = entrySchema.parse(entry);
        source = parsed.originalUrl;
        profileTarget = { attribute: parsed.attrPath, priority: parsed.priority };
      }
      // Only this product's source has the VERSION/build contract we know how to judge.
      const suffix = source.slice(flake.length);
      if (!source.startsWith(flake) || (suffix !== '' && !/^\/[A-Za-z0-9._/-]+$/u.test(suffix)))
        return { failure: 'cannot verify this Nix profile source; refusing to install' };
      if (/\/[a-f0-9]{40}$/u.test(source))
        return {
          failure: 'this Nix profile source is pinned to a revision; change its pin explicitly before updating',
        };
      const metadata = await this.run([...NIX, 'flake', 'metadata', '--refresh', '--json', source]);
      if (metadata.code !== 0) return { failure: 'could not resolve the refreshed Nix revision' };
      const locked = z
        .object({
          locked: z.object({
            type: z.literal('github'),
            owner: z.string(),
            repo: z.string(),
            rev: z.string().regex(/^[a-f0-9]{40}$/u),
          }),
        })
        .parse(JSON.parse(metadata.stdout)).locked;
      if (`github:${locked.owner}/${locked.repo}` !== flake)
        return { failure: 'the refreshed Nix revision belongs to another source' };
      const reference = `${flake}/${locked.rev}`;
      const version = await this.run([
        ...NIX,
        'eval',
        '--raw',
        '--no-registries',
        '--expr',
        `builtins.readFile ((builtins.getFlake "${reference}").outPath + "/VERSION")`,
      ]);
      const parsed = ProtocolVersionSchema.safeParse(version.stdout.trim());
      if (version.code !== 0 || !parsed.success)
        return { failure: 'could not learn VERSION at the locked Nix revision' };
      return {
        source,
        reference,
        version: parsed.data,
        ...(profileTarget === undefined ? {} : { profile: profileTarget }),
      };
    } catch {
      return { failure: 'could not parse the Nix source or locked revision; refusing to install' };
    }
  }

  brewUpgrade(cask: string, observer?: UpdateObserver): Promise<CommandOutcome> {
    return this.#brew(['env', 'HOMEBREW_NO_AUTO_UPDATE=1', 'brew', 'upgrade', '--cask', cask], 'upgrading', observer);
  }

  async nixProfileUpgrade(
    element: string,
    target: LockedNixTarget | undefined,
    observer?: UpdateObserver,
  ): Promise<CommandOutcome> {
    const profile = target?.profile;
    if (profile === undefined || target === undefined)
      return { code: 1, stdout: '', stderr: 'no profile attribute or priority was judged; refusing to install' };
    // Higher numeric priority means LOWER precedence. Adding the new element leaves the old
    // executable active; removing the old one switches it. One rollback restores old precedence.
    const installed = await this.#nix(
      ['profile', 'install', '--no-update-lock-file', '--priority', String(profile.priority + 1)],
      `${target.reference}#${profile.attribute}`,
      observer,
    );
    if (installed.code !== 0) return installed;
    const removed = await this.run([...NIX, 'profile', 'remove', element]);
    if (removed.code === 0) return removed;
    const rollback = await this.nixProfileRollback();
    return {
      ...removed,
      stderr: `${removed.stderr}\n${rollback.code === 0 ? 'the staged profile generation was rolled back' : 'rollback failed; run nix profile rollback before retrying'}`,
    };
  }

  nixProfileRollback(): Promise<CommandOutcome> {
    return this.run([...NIX, 'profile', 'rollback']);
  }

  nixProfileInstall(flake: string, observer?: UpdateObserver, target?: LockedNixTarget): Promise<CommandOutcome> {
    return this.#nix(
      target === undefined ? ['profile', 'install', '--refresh'] : ['profile', 'install', '--no-update-lock-file'],
      target?.reference ?? flake,
      observer,
    );
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
