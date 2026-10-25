import '../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { z } from 'zod';
import type { DaemonHealthRead } from '../../src/lib/daemon-health.ts';
import { DaemonClientProvider } from '../../src/lib/store.tsx';
import { useDaemonHealth } from '../../src/lib/use-daemon-health.ts';
import { type Mounted, mount } from '../support/dom.ts';
import { healthOf } from '../support/health.ts';
import { runAsync } from '../support/react.ts';
import { settleUntil } from '../support/settle.ts';
import { alpha } from './features/config-files/config-files-support.ts';

let shown: Mounted | null = null;
let latest: DaemonHealthRead | null = null;
afterEach(async () => {
  await shown?.unmount();
  shown = null;
  latest = null;
});

function Probe({ daemon }: { readonly daemon: typeof alpha | undefined }) {
  latest = useDaemonHealth(daemon);
  return <span data-read={latest.kind} />;
}

const kind = (): string | null | undefined => shown?.container.querySelector('span')?.getAttribute('data-read');

const served = (body: unknown | Error) => {
  const paths: string[] = [];
  const client = {
    request: async (path: string, schema: z.ZodType<unknown>) => {
      paths.push(path);
      if (body instanceof Error) throw body;
      return schema.parse(body);
    },
  } as unknown as FyApiClient;
  return { paths, factory: async () => client };
};

const mounted = async (daemon: typeof alpha | undefined, factory: ReturnType<typeof served>['factory']) => {
  shown = await mount(
    <DaemonClientProvider client={factory}>
      <Probe daemon={daemon} />
    </DaemonClientProvider>,
  );
};

describe('useDaemonHealth', () => {
  it('reads an old machine’s health, which lists no features', async () => {
    const machine = served(healthOf('4.84.0'));
    await mounted(alpha, machine.factory);
    await settleUntil(() => kind() === 'read', 'the health to be read', runAsync);
    expect(machine.paths).toEqual(['/v1/health']);
    expect(latest?.kind === 'read' && latest.health.features).toBeUndefined();
  });

  it('reads again when the page comes back to the foreground', async () => {
    const machine = served(healthOf('4.84.0'));
    await mounted(alpha, machine.factory);
    await settleUntil(() => kind() === 'read', 'the health to be read', runAsync);
    expect(machine.paths).toHaveLength(1);
    await runAsync(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settleUntil(() => machine.paths.length === 2, 'the second read', runAsync);
  });

  it('reads the features a newer machine lists', async () => {
    await mounted(alpha, served(healthOf('4.90.0', [DAEMON_FEATURES.packIdea4000])).factory);
    await settleUntil(() => kind() === 'read', 'the health to be read', runAsync);
    expect(latest?.kind === 'read' && latest.health.features).toEqual([DAEMON_FEATURES.packIdea4000]);
  });

  it('says failed when the machine cannot be asked, and never reads without a machine', async () => {
    await mounted(alpha, served(new Error('unreachable')).factory);
    await settleUntil(() => kind() === 'failed', 'the read to fail', runAsync);
    await shown?.unmount();
    const idle = served(healthOf('4.84.0'));
    await mounted(undefined, idle.factory);
    expect(kind()).toBe('loading');
    expect(idle.paths).toEqual([]);
  });
});
