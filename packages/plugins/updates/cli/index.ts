import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import type { DaemonUpdateStartRequest, DaemonUpdateView } from '../contract/index.ts';
import manifest from '../manifest.ts';
import type { UpdateMachine } from './lib/machine-seam.ts';
import { DaemonUpdater } from './lib/updater.ts';
import { parseView, runUpdateVerb } from './lib/verb.ts';

const UNAVAILABLE = 69;

const flag = (invocation: VerbInvocation, name: string): boolean => invocation.options[name] === true;
const text = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  return typeof value === 'string' ? value : undefined;
};

/** What a shell may add to the context; each is optional and the verb says what it cannot do without it. */
interface ShellExtras {
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly updateMachine?: UpdateMachine;
}

/**
 * Updates (cli half, §1.4): `fy update`. Shows how this daemon was installed and whether it is behind; with `--yes`
 * (or a yes at the prompt) the daemon starts the update. `--run` is the process the daemon starts for itself.
 */
export default implementCli(manifest, {
  build: ctx => {
    const { client, io } = ctx;
    const extras = ctx as typeof ctx & ShellExtras;
    const view = async (): Promise<DaemonUpdateView> => parseView(await client.call('GET /v1/daemon/update'));
    return {
      verbs: {
        update: async invocation => {
          if (flag(invocation, 'run')) {
            const machine = extras.updateMachine;
            if (machine === undefined) {
              io.err('This fy cannot drive the package managers and the service on this machine yet, so it cannot run an update.\n');
              return UNAVAILABLE;
            }
            const built = machine.deps({ view: async () => await view().catch(() => undefined) });
            await new DaemonUpdater(built.deps).update({
              check: flag(invocation, 'check'),
              ...(text(invocation, 'to') === undefined ? {} : { to: text(invocation, 'to') as string }),
              yes: flag(invocation, 'yes'),
              whenIdle: flag(invocation, 'when-idle'),
              switchToProfile: flag(invocation, 'switch-to-profile'),
              ...(text(invocation, 'report') === undefined ? {} : { report: text(invocation, 'report') as string }),
              json: flag(invocation, 'json'),
            });
            return built.exitCode();
          }
          return await runUpdateVerb(
            {
              view,
              start: async (request: DaemonUpdateStartRequest) =>
                parseView(await client.call('POST /v1/daemon/update', { body: request })),
              out: line => io.out(`${line}\n`),
              err: line => io.err(`${line}\n`),
              ...(extras.sleep === undefined ? {} : { sleep: extras.sleep }),
              ...(extras.confirm === undefined ? {} : { confirm: extras.confirm }),
            },
            {
              check: flag(invocation, 'check'),
              yes: flag(invocation, 'yes'),
              whenIdle: flag(invocation, 'when-idle'),
              to: text(invocation, 'to'),
              json: flag(invocation, 'json'),
            },
          );
        },
      },
    };
  },
});
