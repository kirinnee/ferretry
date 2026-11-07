import { implementCli, type VerbHandler, type VerbInvocation } from '@ferretry/kernel/manifest';
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

/**
 * The item verbs (`settings`) edit config collections, and the item-kind service that serves them has
 * no route in this build. Said plainly rather than pretended.
 */
const itemVerb =
  (io: { err(text: string): void }, what: string): VerbHandler =>
  async () => {
    io.err(`Codex ${what} items are edited through the item service, which is not served by this daemon yet; nothing was changed.`);
    return 69;
  };

export default implementCli(manifest, {
  build: ({ client, io }) => {
    const view = async (): Promise<HarnessCliView> => await client.call<HarnessCliView>(GET_UPDATE);
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
            for (const step of plan.steps) io.out(`  ${step.command}${step.note === undefined ? '' : `   # ${step.note}`}\n`);
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
        'harness codex settings ls': itemVerb(io, 'settings'),
        'harness codex settings show': itemVerb(io, 'settings'),
        'harness codex settings add': itemVerb(io, 'settings'),
        'harness codex settings edit': itemVerb(io, 'settings'),
        'harness codex settings rm': itemVerb(io, 'settings'),
      },
    };
  },
});
