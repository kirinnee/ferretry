import type { TmuxLaunch } from './contracts.ts';

/**
 * The last check before a pane exists: may this launch run at all?
 *
 * It exists for ONE caller. A daemon booted by a test suite must never exec the owner's real Claude
 * Code or Codex: a session that reaches one spends the owner's quota and can touch the owner's real
 * accounts, and a test that leaks its tmux server keeps that harness alive for days. A guard that
 * refuses throws a {@link LaunchGuardRefusal}, and the launch fails loudly instead of quietly running the real thing:
 * the runner logs the sentence and answers the closed refusal `real_harness`, which Ferrets reports as the reason.
 */
export interface TmuxLaunchGuard {
  check(launch: TmuxLaunch): Promise<void>;
}

/** The harnesses a generated runtime wrapper execs BY NAME, so a guard has to resolve both itself. */
export const GUARDED_HARNESS_NAMES = ['claude', 'codex'] as const;

/** Any launch a guard refused. A runner catches exactly this kind, logs its sentence and answers a closed refusal. */
export abstract class LaunchGuardRefusal extends Error {}

/** A launch a guard refused, naming the binary and the install it belongs to. */
export class RealHarnessRefusedError extends LaunchGuardRefusal {
  constructor(
    readonly harness: string,
    readonly resolved: string,
    readonly install: string,
  ) {
    super(
      `test mode refused to launch a real harness: ${harness} resolves to ${resolved} (${install}). ` +
        `A test must put a fake ${GUARDED_HARNESS_NAMES.join('/')} first on PATH before it starts a session.`,
    );
    this.name = 'RealHarnessRefusedError';
  }
}

/**
 * Why an armed guard could not tell which harness a launch reaches, so it refused it. FAILS CLOSED: a search the
 * guard cannot make is never read as "no real harness found".
 *
 * - `own-path`: the launch's environment sets `PATH` through a handle whose values the guard never sees, so the pane
 *   would look `claude` up on a PATH the guard cannot search.
 * - `no-path`: the kernel handed no search path at all, so a bare `claude` cannot be looked up.
 */
export class UnprovableHarnessError extends LaunchGuardRefusal {
  constructor(readonly why: 'own-path' | 'no-path') {
    super(
      why === 'own-path'
        ? 'test mode refused to launch: the launch sets its own PATH, so it cannot prove which ' +
            `${GUARDED_HARNESS_NAMES.join('/')} the pane reaches. A test must not set PATH in a ferret's environment.`
        : 'test mode refused to launch: this daemon has no PATH to search, so it cannot prove which ' +
            `${GUARDED_HARNESS_NAMES.join('/')} the pane reaches. A test must put a fake first on the daemon's PATH.`,
    );
    this.name = 'UnprovableHarnessError';
  }
}

/**
 * Where a real install of either harness lives, each with the name a refusal reports.
 *
 * A DENYLIST, deliberately. A fake is any executable a test writes, anywhere it likes, so there is no
 * allowlist that would not also reject the next fixture; the real installs, on the other hand, come
 * from a handful of package managers whose layouts are stable. The paths are matched after symlinks
 * are resolved, which is how a `~/.nix-profile/bin/claude` becomes the store path it really is.
 */
const REAL_HARNESS_INSTALLS: readonly { readonly install: string; readonly pattern: RegExp }[] = [
  { install: 'the Nix claude-code package', pattern: /\/nix\/store\/[a-z0-9]{32}-claude-code-[^/]*\// },
  { install: 'the Nix codex package', pattern: /\/nix\/store\/[a-z0-9]{32}-codex(?:-cli)?-\d[^/]*\// },
  { install: 'the npm @anthropic-ai/claude-code package', pattern: /\/@anthropic-ai\/claude-code(?:\/|$)/ },
  { install: 'the npm @openai/codex package', pattern: /\/@openai\/codex(?:\/|$)/ },
  { install: 'the Claude Code wrapper pair', pattern: /\/\.claude-(?:un)?wrapped$/ },
  { install: 'the Claude Code native installer', pattern: /\/\.local\/share\/claude\/versions\// },
  { install: 'the Claude Code local install', pattern: /\/\.claude\/local\// },
  { install: 'a Homebrew harness install', pattern: /\/(?:Caskroom|Cellar)\/(?:claude-code|codex)\// },
];

/** The install a resolved executable belongs to, or `undefined` when it is not a real harness. */
export function realHarnessInstall(path: string): string | undefined {
  return REAL_HARNESS_INSTALLS.find(candidate => candidate.pattern.test(path))?.install;
}
