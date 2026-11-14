import { ConfigItems, implementCli, itemVerb, mappingItemKind, type VerbInvocation } from '@ferretry/kernel/manifest';
import { type HarnessCliView, VersionSchema } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { renderStatus } from './lib/render.ts';

const GET_UPDATE = 'GET /v1/codex/update';
const POST_UPDATE = 'POST /v1/codex/update';

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
        collection: 'codex/settings',
        noun: 'Codex settings item',
        layer: 'settings',
        command: 'harness codex settings',
        key: 'settings',
        readText,
      }),
    );
    const hooks = new ConfigItems(
      deps,
      mappingItemKind({
        collection: 'codex/hooks',
        noun: 'Codex hooks item',
        layer: 'hooks',
        command: 'harness codex hooks',
        key: 'hooks',
        readText,
      }),
    );
    const item = (body: () => Promise<number>): Promise<number> => itemVerb({ io }, body);
    return {
      verbs: {
        'harness codex status': async invocation => {
          const current = await view();
          io.out(`${on(invocation, 'json') ? JSON.stringify(current, null, 2) : renderStatus(current, 'fy')}\n`);
          return 0;
        },
        'harness codex update': async invocation => {
          const requested = text(invocation, 'to');
          if (requested !== undefined && requested !== 'verified' && !VersionSchema.safeParse(requested).success) {
            io.err(`--to takes a version like 0.145.0, or "verified"; got "${requested}"\n`);
            return 2;
          }
          const current = await view();
          if (current.method === null || current.plan === null) {
            io.err('Codex: this daemon cannot find it, so there is nothing to update.\n');
            return 1;
          }
          const plan = current.plan;
          if (plan.kind === 'manual') {
            io.err(`Codex: ${plan.explanation}\n`);
            for (const step of plan.steps)
              io.out(`  ${step.command}${step.note === undefined ? '' : `   # ${step.note}`}\n`);
            return 1;
          }
          if (!on(invocation, 'yes')) {
            io.err(
              `Codex would update with: ${plan.steps.map(step => step.command).join(', then ')}\nNothing was changed: this needs a yes. Re-run with --yes to go ahead.\n`,
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
          io.out(`Updating Codex${command}. This can take a few minutes; follow it with: fy harness codex status\n`);
          return 0;
        },
        'harness codex settings ls': async invocation =>
          await item(() => settings.ls({ json: on(invocation, 'json') })),
        'harness codex settings show': async invocation =>
          await item(() => settings.show(invocation.args[0], { json: on(invocation, 'json') })),
        'harness codex settings add': async invocation => await item(() => settings.add(invocation)),
        'harness codex settings edit': async invocation => await item(() => settings.edit(invocation)),
        'harness codex settings rm': async invocation => await item(() => settings.remove(invocation)),
        'harness codex hooks ls': async invocation => await item(() => hooks.ls({ json: on(invocation, 'json') })),
        'harness codex hooks show': async invocation =>
          await item(() => hooks.show(invocation.args[0], { json: on(invocation, 'json') })),
        'harness codex hooks add': async invocation => await item(() => hooks.add(invocation)),
        'harness codex hooks edit': async invocation => await item(() => hooks.edit(invocation)),
        'harness codex hooks rm': async invocation => await item(() => hooks.remove(invocation)),
      },
    };
  },
});
