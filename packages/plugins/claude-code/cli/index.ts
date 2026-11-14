import { ConfigItems, implementCli, itemVerb, mappingItemKind, type VerbInvocation } from '@ferretry/kernel/manifest';
import { type HarnessCliView, VersionSchema } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { renderStatus } from './lib/render.ts';

const GET_UPDATE = 'GET /v1/claude-code/update';
const POST_UPDATE = 'POST /v1/claude-code/update';

const on = (invocation: VerbInvocation, name: string): boolean => {
  const value = invocation.options[name];
  return value === true || value === 'true';
};

const text = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[value.length - 1] as string | undefined) : undefined;
};

/** The binary's name every hint names (`CliContext` does not carry it; single-sourced in `packages/cli/package.json`). */
const BINARY_NAME = 'fy';

export default implementCli(manifest, {
  build: ({ client, io, readText, confirm }) => {
    const view = async (): Promise<HarnessCliView> => await client.call<HarnessCliView>(GET_UPDATE);
    const deps = { client, io, binary: BINARY_NAME, ...(confirm === undefined ? {} : { confirm }) };
    const settings = new ConfigItems(
      deps,
      mappingItemKind({
        collection: 'claude-code/settings',
        noun: 'Claude Code settings item',
        layer: 'settings',
        command: 'harness claude-code settings',
        key: 'settings',
        readText,
      }),
    );
    const hooks = new ConfigItems(
      deps,
      mappingItemKind({
        collection: 'claude-code/hooks',
        noun: 'Claude Code hooks item',
        layer: 'hooks',
        command: 'harness claude-code hooks',
        key: 'hooks',
        readText,
      }),
    );
    const item = (body: () => Promise<number>): Promise<number> => itemVerb({ io }, body);
    return {
      verbs: {
        'harness claude-code status': async invocation => {
          const current = await view();
          io.out(`${on(invocation, 'json') ? JSON.stringify(current, null, 2) : renderStatus(current, 'fy')}\n`);
          return 0;
        },
        'harness claude-code update': async invocation => {
          const requested = text(invocation, 'to');
          if (requested !== undefined && requested !== 'verified' && !VersionSchema.safeParse(requested).success) {
            io.err(`--to takes a version like 2.1.220, or "verified"; got "${requested}"\n`);
            return 2;
          }
          const current = await view();
          if (current.method === null || current.plan === null) {
            io.err('Claude Code: this daemon cannot find it, so there is nothing to update.\n');
            return 1;
          }
          const plan = current.plan;
          if (plan.kind === 'manual') {
            io.err(`Claude Code: ${plan.explanation}\n`);
            for (const step of plan.steps)
              io.out(`  ${step.command}${step.note === undefined ? '' : `   # ${step.note}`}\n`);
            return 1;
          }
          if (!on(invocation, 'yes')) {
            io.err(
              `Claude Code would update with: ${plan.steps.map(step => step.command).join(', then ')}\nNothing was changed: this needs a yes. Re-run with --yes to go ahead.\n`,
            );
            return 1;
          }
          const target = requested === 'verified' ? current.verified.version : requested;
          const started = await client.call<HarnessCliView>(POST_UPDATE, {
            body: {
              ...(target === undefined ? {} : { target }),
              ...(on(invocation, 'allow-unverified') ? { confirmUnverified: true } : {}),
            },
          });
          const command = started.job?.state === 'running' ? ` (${started.job.command})` : '';
          io.out(
            `Updating Claude Code${command}. This can take a few minutes; follow it with: fy harness claude-code status\n`,
          );
          return 0;
        },
        'harness claude-code settings ls': async invocation =>
          await item(() => settings.ls({ json: on(invocation, 'json') })),
        'harness claude-code settings show': async invocation =>
          await item(() => settings.show(invocation.args[0], { json: on(invocation, 'json') })),
        'harness claude-code settings add': async invocation => await item(() => settings.add(invocation)),
        'harness claude-code settings edit': async invocation => await item(() => settings.edit(invocation)),
        'harness claude-code settings rm': async invocation => await item(() => settings.remove(invocation)),
        'harness claude-code hooks ls': async invocation =>
          await item(() => hooks.ls({ json: on(invocation, 'json') })),
        'harness claude-code hooks show': async invocation =>
          await item(() => hooks.show(invocation.args[0], { json: on(invocation, 'json') })),
        'harness claude-code hooks add': async invocation => await item(() => hooks.add(invocation)),
        'harness claude-code hooks edit': async invocation => await item(() => hooks.edit(invocation)),
        'harness claude-code hooks rm': async invocation => await item(() => hooks.remove(invocation)),
      },
    };
  },
});
