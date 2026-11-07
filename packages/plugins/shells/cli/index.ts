import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import type {
  NixFacts,
  ShellAdded,
  ShellBuildResult,
  ShellDetail,
  ShellPreview,
  ShellSummary,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { detailLines, lockLines, nixLines, summaryLines } from './lib/render.ts';

const OK = 0;
const USAGE = 2;

const wantsJson = (invocation: VerbInvocation): boolean => invocation.options.json === true;

const text = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : undefined;
};

/**
 * Shells (cli half, §4.9): `fy shell …`. Adding and re-locking resolve first and SHOW what the source resolved to;
 * nothing is pinned until you say `--yes`. Write positionals before options.
 */
export default implementCli(manifest, {
  build: ({ client, io }) => {
    const usage = (line: string): number => {
      io.err(`usage: ${line}`);
      return USAGE;
    };
    const print = (value: unknown, lines: readonly string[], invocation: VerbInvocation): void => {
      if (wantsJson(invocation)) io.out(JSON.stringify(value));
      else for (const line of lines) io.out(line);
    };
    const pathOf = (name: string): { readonly params: Record<string, string> } => ({ params: { name } });

    return {
      verbs: {
        'shell ls': async invocation => {
          const { shells } = await client.call<{ shells: ShellSummary[] }>('GET /v1/shells');
          print({ shells }, summaryLines(shells), invocation);
          return OK;
        },

        'shell show': async invocation => {
          const [name] = invocation.args;
          if (name === undefined) return usage('fy shell show <name>');
          const detail = await client.call<ShellDetail>('GET /v1/shells/:name', pathOf(name));
          print(detail, detailLines(detail), invocation);
          return OK;
        },

        'shell add': async invocation => {
          const [name] = invocation.args;
          const flake = text(invocation, 'flake');
          const packages = text(invocation, 'packages');
          if (name === undefined || (flake === undefined) === (packages === undefined))
            return usage(
              'fy shell add <name> --flake <address> | --packages <a,b> [--floating] [--description <text>] [--yes]',
            );
          const description = text(invocation, 'description');
          const item = {
            ...(description === undefined ? {} : { description }),
            ...(flake === undefined
              ? {
                  packages: (packages ?? '')
                    .split(',')
                    .map(part => part.trim())
                    .filter(part => part !== ''),
                }
              : { flake }),
            floating: invocation.options.floating === true,
          };
          const preview = await client.call<ShellPreview>('POST /v1/shells/preview', { body: { name, item } });
          if (invocation.options.yes !== true) {
            print(
              preview,
              [
                `${name} would be pinned to:`,
                ...lockLines(preview.lock),
                'to pin it and allow the build, run the same command with --yes',
              ],
              invocation,
            );
            return OK;
          }
          const added = await client.call<ShellAdded>('POST /v1/shells', { body: { name, item } });
          const lines = [
            `${name} is pinned:`,
            ...lockLines(added.lock),
            ...(added.held === undefined ? [] : ['waiting for your confirmation:', ...added.held]),
          ];
          print(added, lines, invocation);
          return OK;
        },

        'shell relock': async invocation => {
          const [name] = invocation.args;
          if (name === undefined) return usage('fy shell relock <name> [--yes]');
          const detail = await client.call<ShellDetail>('GET /v1/shells/:name', pathOf(name));
          const preview = await client.call<ShellPreview>('POST /v1/shells/preview', {
            body: { name, item: detail.item },
          });
          if (preview.changedFrom !== undefined && invocation.options.yes !== true) {
            print(
              preview,
              [
                `${name} now resolves differently (was ${preview.changedFrom}):`,
                ...lockLines(preview.lock),
                'to use the new one, run the same command with --yes',
              ],
              invocation,
            );
            return OK;
          }
          const locked = await client.call<ShellPreview>('POST /v1/shells/:name/relock', pathOf(name));
          print(locked, [`${name} is locked:`, ...lockLines(locked.lock)], invocation);
          return OK;
        },

        'shell build': async invocation => {
          const [name] = invocation.args;
          if (name === undefined) return usage('fy shell build <name>');
          const result = await client.call<ShellBuildResult>('POST /v1/shells/:name/build', pathOf(name));
          print(result, [result.outcome === 'cached' ? `${name} was already built` : `${name} is built`], invocation);
          return OK;
        },

        'shell rm': async invocation => {
          const [name] = invocation.args;
          if (name === undefined) return usage('fy shell rm <name>');
          const removed = await client.call<{ name: string }>('DELETE /v1/shells/:name', pathOf(name));
          print(removed, [`removed ${removed.name}`], invocation);
          return OK;
        },

        'shell nix': async invocation => {
          const facts = await client.call<NixFacts>('GET /v1/shells/nix');
          print(facts, nixLines(facts), invocation);
          return OK;
        },
      },
    };
  },
});
