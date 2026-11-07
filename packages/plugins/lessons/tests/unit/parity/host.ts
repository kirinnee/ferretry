/**
 * The Lessons daemon half on the kernel's test host, over the fakes its manifest needs (Ferrets, Conversation).
 *
 * The host's stand-in admission hands a handler the test caller (`call.caller`) but no credential; Gate's real one
 * attaches the ferret's own (`tokenClass: 'ferret'`) and the host owner's ungoverned standing. This wrapper adds exactly those,
 * and nothing else, so `ferretOf(call)` and Apply's grant check read the caller as they do in the daemon.
 */
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import type { CallContext } from '@ferretry/kernel/contract';
import type { DaemonImplementation, Manifest } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import lessons from '../../../daemon/index.ts';

type Built = {
  routes?: Record<string, (call: CallContext) => unknown>;
  tools?: Record<string, (call: CallContext, input: unknown) => unknown>;
};

const withCredential = (call: CallContext): CallContext => {
  const caller = (call as { caller?: { kind: string; id?: string } }).caller;
  if (caller?.kind === 'ferret')
    return { ...call, credential: { tokenClass: 'ferret', ferret: caller.id } } as unknown as CallContext;
  // The owner at the machine is ungoverned (Gate's `arrivedOnHost`); the stand-in carries no governance at all.
  if (caller?.kind === 'owner' && call.governance === undefined)
    return { ...call, governance: { governed: false, decide: () => ({ allowed: true }) } } as unknown as CallContext;
  return call;
};

const credentialed = {
  ...lessons,
  build: (ctx: Parameters<NonNullable<typeof lessons.build>>[0]) => {
    const built = lessons.build?.(ctx) as unknown as Built;
    return {
      ...built,
      routes: Object.fromEntries(
        Object.entries(built.routes ?? {}).map(([key, handler]) => [
          key,
          (call: CallContext) => handler(withCredential(call)),
        ]),
      ),
      tools: Object.fromEntries(
        Object.entries(built.tools ?? {}).map(([key, handler]) => [
          key,
          (call: CallContext, input: unknown) => handler(withCredential(call), input),
        ]),
      ),
    } as never;
  },
} as unknown as DaemonImplementation<Manifest>;

export async function lessonsHost(options: { readonly config?: Readonly<Record<string, unknown>> } = {}) {
  const ferrets = new FakeFerrets();
  const conversation = fakeConversation();
  const host = await testHost({
    plugins: [credentialed],
    fakes: { ferrets, conversation },
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  return { host, ferrets, conversation };
}
