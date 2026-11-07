/**
 * WHAT UPDATING CODEX TAKES, for one install method. Pure.
 *
 * Only a method that needs no `sudo` and changes nobody's configuration is `self`, the same line the daemon's own
 * update draws: a module install is pinned by somebody's flake, a temporary nix shell is gone at the next garbage
 * collection, and a binary Ferretry did not recognise is not Ferretry's to replace.
 */
import type { HarnessInstallMethod, HarnessUpdatePlan } from '../../../contract/index.ts';
import { nixModuleUpdate, type UpdateStep } from './install-method.ts';
import { CODEX_LABEL, CODEX_PACKAGES } from './version.ts';

/** The programs an update runs. `harness` is Codex's own binary. */
export type HarnessUpdateProgram = 'npm' | 'pnpm' | 'bun' | 'volta' | 'brew' | 'nix' | 'harness';

/** One command an update runs: a program and its arguments, never a shell string. */
export interface HarnessCommand {
  readonly program: HarnessUpdateProgram;
  readonly args: readonly string[];
}

/** A command as a person types it. */
export function harnessCommandLine(command: HarnessCommand): string {
  return [command.program === 'harness' ? 'codex' : command.program, ...command.args].join(' ');
}

/** What updating takes for one install method. */
export type HarnessUpdateRecipe =
  | {
      readonly kind: 'self';
      readonly run: readonly HarnessCommand[];
      /** Whether the method installs exactly the version asked for; Homebrew and nix take what they have. */
      readonly pinsVersion: boolean;
      /** What puts the previous version back, given it; `undefined` when the method keeps none. */
      readonly rollback: ((previous: string) => readonly HarnessCommand[]) | undefined;
    }
  | { readonly kind: 'manual'; readonly explanation: string; readonly steps: readonly UpdateStep[] };

function nodeInstall(method: Extract<HarnessInstallMethod, { kind: 'npm-global' }>, version: string): HarnessCommand {
  const spec = `${method.package}@${version}`;
  switch (method.tool) {
    case 'npm':
      return {
        program: 'npm',
        args: ['install', '-g', ...(method.prefix === undefined ? [] : ['--prefix', method.prefix]), spec],
      };
    case 'pnpm':
      return { program: 'pnpm', args: ['add', '-g', spec] };
    case 'bun':
      return { program: 'bun', args: ['add', '-g', spec] };
    case 'volta':
      return { program: 'volta', args: ['install', spec] };
  }
}

/** What updating takes for this method, to `target` (`undefined` is 'the newest'). */
export function codexUpdateRecipe(method: HarnessInstallMethod, target: string | undefined): HarnessUpdateRecipe {
  switch (method.kind) {
    case 'npm-global':
      return {
        kind: 'self',
        run: [nodeInstall(method, target ?? 'latest')],
        pinsVersion: true,
        rollback: previous => [nodeInstall(method, previous)],
      };
    case 'homebrew':
      return {
        kind: 'self',
        run: [
          { program: 'brew', args: ['update'] },
          {
            program: 'brew',
            args: method.type === 'cask' ? ['upgrade', '--cask', method.package] : ['upgrade', method.package],
          },
        ],
        pinsVersion: false,
        rollback: undefined,
      };
    case 'nix-profile':
      return {
        kind: 'self',
        run: [{ program: 'nix', args: ['profile', 'upgrade', '--refresh', method.element] }],
        pinsVersion: false,
        rollback: () => [{ program: 'nix', args: ['profile', 'rollback'] }],
      };
    case 'nix-module': {
      const update = nixModuleUpdate(method, {
        subject: CODEX_LABEL,
        input: 'nixpkgs',
        inputNote: `the input that provides ${CODEX_PACKAGES.nixpkgs} is usually nixpkgs, or an overlay that packages it`,
      });
      return { kind: 'manual', explanation: update.explanation, steps: update.steps };
    }
    case 'nix-shell':
      return {
        kind: 'manual',
        explanation: `${CODEX_LABEL} here runs from a temporary nix shell store path, which never updates and which garbage collection can delete. Install it into your nix profile, and every later update is one click.`,
        steps: [{ command: `nix profile install nixpkgs#${CODEX_PACKAGES.nixpkgs}` }],
      };
    case 'standalone':
      return {
        kind: 'manual',
        explanation: `${CODEX_LABEL} here is a file in ${method.directory} that no package manager Ferretry knows owns — usually a binary from its GitHub releases. Replace it with the new release, or reinstall with npm so later updates are one click.`,
        steps: [
          {
            command: `npm install -g ${CODEX_PACKAGES.npm}`,
            note: 'or download the new release from https://github.com/openai/codex/releases/latest',
          },
        ],
      };
    case 'unknown':
      return {
        kind: 'manual',
        explanation: `Ferretry cannot update ${CODEX_LABEL} here: ${method.reason}.`,
        steps: [],
      };
  }
}

/** The recipe as a person reads it. */
export function codexUpdatePlan(method: HarnessInstallMethod, target: string | undefined): HarnessUpdatePlan {
  const recipe = codexUpdateRecipe(method, target);
  if (recipe.kind === 'manual') return { kind: 'manual', explanation: recipe.explanation, steps: [...recipe.steps] };
  return {
    kind: 'self',
    steps: recipe.run.map(command => ({ command: harnessCommandLine(command) })) as [
      { command: string },
      ...{ command: string }[],
    ],
    rollback: recipe.rollback === undefined ? 'none' : 'automatic',
    pinsVersion: recipe.pinsVersion,
  };
}
