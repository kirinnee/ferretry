/**
 * The Lessons daemon half on the kernel's test host, over the fakes its manifest needs (Ferrets, Conversation).
 *
 * The host's stand-in admission hands a handler the test caller (`call.caller`) but no credential; Gate's real one
 * attaches the ferret's own (`tokenClass: 'ferret'`) and the host owner's ungoverned standing. This wrapper adds exactly those,
 * and nothing else, so `ferretOf(call)` and Apply's grant check read the caller as they do in the daemon.
 */
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import type { CallContext, Log } from '@ferretry/kernel/contract';
import { config as hostConfig, state as hostState } from '@ferretry/kernel/host';
import type { DaemonImplementation, Manifest } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { LESSONS_CONFIG } from '../../../contract/index.ts';
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

const HOME = '/home/fy';
const quiet: Log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet };

/**
 * The kernel's REAL config writer (`createConfigFiles`, the one the daemon hands every plugin) over an in-memory home
 * that declares `lessons.yaml`: a write edits only the changed keys, refuses a raw secret, keeps the last good version
 * and holds what the owner must confirm. `handEdit` is the owner editing the file outside Ferretry, then the watcher's
 * reload — a hand edit is never judged, only compared with what is in effect, so one that loosens is HELD. With no judge
 * a loosening write is held for the owner, as it is for any call Gate's judge does not let put one into effect.
 * `judge: 'owner-at-machine'` answers what Gate's `judgeConfigWrite` answers the host owner (apply,
 * `packages/core/gate/daemon/lib/policy/config-judge.ts`); the real one is in Gate's daemon half, which a Lessons test
 * may not import (context-imports).
 */
export function realLessonsConfig(options: { readonly judge?: 'owner-at-machine' } = {}) {
  const fs = hostState.createMemoryHostFs();
  const path = `${HOME}/config/${LESSONS_CONFIG.file}`;
  const files = hostConfig.createConfigFiles({
    home: HOME,
    fs,
    clock: { nowMs: () => Date.parse('2026-11-07T12:00:00.000Z'), after: () => () => {}, every: () => () => {} },
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'lessons', def: LESSONS_CONFIG }],
    ...(options.judge === undefined ? {} : { judge: () => true }),
  });
  return {
    files,
    port: files.port('lessons'),
    text: async (): Promise<string | undefined> => await fs.readText(path).catch(() => undefined),
    handEdit: async (text: string): Promise<void> => {
      fs.seed(path, text);
      await files.reload();
    },
  };
}

export type RealLessonsConfig = ReturnType<typeof realLessonsConfig>;

const credentialedOver = (real: RealLessonsConfig | undefined) => ({
  ...lessons,
  build: (given: Parameters<NonNullable<typeof lessons.build>>[0]) => {
    // On the real writer the half's `kernel.config` is the kernel's own port; nothing else of the kernel changes.
    const ctx = real === undefined ? given : { ...given, kernel: { ...given.kernel, config: real.port } };
    const built = lessons.build?.(ctx as typeof given) as unknown as Built;
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
});

const credentialed = credentialedOver(undefined) as unknown as DaemonImplementation<Manifest>;

export async function lessonsHost(
  options: { readonly config?: Readonly<Record<string, unknown>>; readonly realConfig?: RealLessonsConfig } = {},
) {
  const ferrets = new FakeFerrets();
  const conversation = fakeConversation();
  const host = await testHost({
    plugins: [
      options.realConfig === undefined
        ? credentialed
        : (credentialedOver(options.realConfig) as unknown as DaemonImplementation<Manifest>),
    ],
    fakes: { ferrets, conversation },
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  return { host, ferrets, conversation };
}
