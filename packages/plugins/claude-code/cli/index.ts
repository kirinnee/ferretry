import { configItemVerbs, implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
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

export default implementCli(manifest, {
  build: ({ client, io, readText, confirm }) => {
    const items = (collection: 'settings' | 'hooks') =>
      configItemVerbs({
        collection: `claude-code/${collection}`,
        noun: `Claude Code ${collection} item`,
        verbPrefix: `harness claude-code ${collection}`,
        client,
        io,
        readText,
        confirm,
      });
    const settings = items('settings');
    const hooks = items('hooks');
    const view = async (): Promise<HarnessCliView> => await client.call<HarnessCliView>(GET_UPDATE);
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
        'harness claude-code settings ls': settings.ls,
        'harness claude-code settings show': settings.show,
        'harness claude-code settings add': settings.add,
        'harness claude-code settings edit': settings.edit,
        'harness claude-code settings rm': settings.rm,
        'harness claude-code hooks ls': hooks.ls,
        'harness claude-code hooks show': hooks.show,
        'harness claude-code hooks add': hooks.add,
        'harness claude-code hooks edit': hooks.edit,
        'harness claude-code hooks rm': hooks.rm,
      },
    };
  },
});
