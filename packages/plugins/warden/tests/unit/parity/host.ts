import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import type { Log } from '@ferretry/kernel/contract';
import { config as hostConfig, state as hostState } from '@ferretry/kernel/host';
import type { DaemonImplementation, Manifest } from '@ferretry/kernel/manifest';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import { WARDEN_CONFIG } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';

const HOME = '/home/fy';
const quiet: Log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet };

/**
 * The kernel's REAL config writer (`createConfigFiles`, the one the daemon hands every plugin) over an in-memory home
 * that declares `warden.yaml`. With no judge a loosening is HELD for the owner, as it is for any call Gate's judge does
 * not let put one into effect. `judge: 'owner-at-machine'` answers what Gate's `judgeConfigWrite` answers the host
 * owner (`governance.governed === false` → apply, `packages/core/gate/daemon/lib/policy/config-judge.ts`); the real one
 * is in Gate's daemon half, which a Warden test may not import (context-imports). `handEdit` is the owner editing the
 * file outside Ferretry, then the watcher's reload — a hand edit is never judged, only compared with what is in effect.
 */
export function realWardenConfig(options: { readonly judge?: 'owner-at-machine' } = {}) {
  const fs = hostState.createMemoryHostFs();
  const path = `${HOME}/config/${WARDEN_CONFIG.file}`;
  const files = hostConfig.createConfigFiles({
    home: HOME,
    fs,
    clock: { nowMs: () => Date.parse('2026-11-07T12:00:00.000Z'), after: () => () => {}, every: () => () => {} },
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'warden', def: WARDEN_CONFIG }],
    ...(options.judge === undefined ? {} : { judge: () => true }),
  });
  return {
    port: files.port('warden'),
    text: async (): Promise<string | undefined> => await fs.readText(path).catch(() => undefined),
    handEdit: async (text: string): Promise<void> => {
      fs.seed(path, text);
      await files.reload();
    },
    /** A hand edit on disk the kernel has NOT reloaded yet (inside the watcher's poll-and-settle window). */
    plant: (text: string): void => {
      fs.seed(path, text);
    },
  };
}

export type RealWardenConfig = ReturnType<typeof realWardenConfig>;

/** The real half, with `kernel.config` the real writer's port when one is given; nothing else of the kernel changes. */
const over = (real: RealWardenConfig): DaemonImplementation<Manifest> =>
  ({
    ...daemon,
    build: (given: Parameters<NonNullable<typeof daemon.build>>[0]) =>
      daemon.build?.({ ...given, kernel: { ...given.kernel, config: real.port } } as typeof given),
  }) as unknown as DaemonImplementation<Manifest>;

/** The real daemon half over the contract fakes of what it needs, on the kernel's test host. */
export async function wardenHost(options: { readonly config?: unknown; readonly realConfig?: RealWardenConfig } = {}) {
  const ferrets = new FakeFerrets();
  const asks = new FakeAsks();
  const conversation = fakeConversation();
  const clock = fixedClock('2026-11-07T12:00:00.000Z');
  const host = await testHost({
    plugins: [options.realConfig === undefined ? daemon : over(options.realConfig)],
    fakes: { ferrets, asks, conversation },
    clock,
  });
  if (options.config !== undefined) host.setConfig('warden.yaml', options.config);
  return { host, ferrets, asks, conversation, clock };
}
