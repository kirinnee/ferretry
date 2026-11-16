/** The Usage daemon half on the kernel's test host, over the fakes its manifest needs, recording the jobs it schedules. */
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { JobSpec } from '@ferretry/kernel/contract';
import type { DaemonImplementation, Manifest } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import usage from '../../../daemon/index.ts';

export async function usageHost(options: { readonly config?: Readonly<Record<string, unknown>> } = {}) {
  const scheduled: JobSpec[] = [];
  const built: { hooks?: Record<string, (input: unknown) => unknown> } = {};
  const recording = {
    ...usage,
    build: (ctx: Parameters<NonNullable<typeof usage.build>>[0]) => {
      const half = usage.build?.({
        ...ctx,
        kernel: {
          ...ctx.kernel,
          jobs: {
            ...ctx.kernel.jobs,
            add: (job: JobSpec) => {
              scheduled.push(job);
              ctx.kernel.jobs.add(job);
            },
          },
        },
      } as typeof ctx);
      built.hooks = (half as { hooks?: typeof built.hooks } | undefined)?.hooks;
      return half as never;
    },
  } as unknown as DaemonImplementation<Manifest>;
  const ferrets = new FakeFerrets();
  const host = await testHost({
    plugins: [recording],
    fakes: {
      ferrets,
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
      vault: new FakeVault(),
    },
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  return { host, scheduled, ferrets, hooks: built.hooks ?? {} };
}
