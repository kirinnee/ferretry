import '../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { z } from 'zod';
import { type MachinePack, type PackSave, useMachinePack } from '../../../../src/features/pack/use-machine-pack.ts';
import type { DaemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { DaemonClientProvider } from '../../../../src/lib/store.tsx';
import { type Mounted, mount } from '../../../support/dom.ts';
import { PACK_VIEW } from '../../../support/pack.ts';
import { runAsync } from '../../../support/react.ts';
import { settleUntil } from '../../../support/settle.ts';
import { alpha, fileView } from '../config-files/config-files-support.ts';

interface Wire {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** Serves `GET /v1/pack`, the two files' text, and answers a write with `put`; every call is recorded. */
const fake = ({
  view = (): unknown => PACK_VIEW,
  text = '',
  put = () => ({ path: 'pack.yaml', etag: 'e2', outcome: 'applied' }),
}: {
  readonly view?: () => unknown;
  readonly text?: string;
  readonly put?: () => unknown;
} = {}) => {
  const wire: Wire[] = [];
  const client = {
    request: async (path: string, schema: z.ZodType<unknown>, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      wire.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
      if (path === '/v1/pack') return schema.parse(view());
      if (method === 'PUT') return schema.parse(put());
      const file = decodeURIComponent(path.split('path=')[1] ?? '');
      return schema.parse(
        fileView({
          path: file,
          kind: file === 'pack.yaml' ? 'pack' : 'modelsGuide',
          schema: file === 'pack.yaml' ? 'pack' : 'modelsGuide',
          text,
          etag: 'e1',
        }),
      );
    },
  } as unknown as FyApiClient;
  return { wire, factory: async () => client };
};

let shown: Mounted | null = null;
let latest: MachinePack | null = null;

afterEach(async () => {
  await shown?.unmount();
  shown = null;
  latest = null;
});

function Probe({ daemon }: { readonly daemon: DaemonConnection | undefined }) {
  latest = useMachinePack(daemon);
  return <span data-read={latest.read.kind} />;
}

const mounted = async (daemon: DaemonConnection | undefined, factory: ReturnType<typeof fake>['factory']) => {
  shown = await mount(
    <DaemonClientProvider client={factory}>
      <Probe daemon={daemon} />
    </DaemonClientProvider>,
  );
};

const readKind = (): string | null | undefined => shown?.container.querySelector('span')?.getAttribute('data-read');

const run = async (save: (pack: MachinePack) => Promise<PackSave>): Promise<PackSave> => {
  let result: PackSave | null = null;
  await runAsync(async () => {
    result = latest === null ? null : await save(latest);
  });
  if (result === null) throw new Error('no save result');
  return result;
};

describe('useMachinePack', () => {
  it('reads nothing without a machine and refuses a save', async () => {
    const served = fake();
    await mounted(undefined, served.factory);
    expect(readKind()).toBe('failed');
    expect(served.wire).toEqual([]);
    expect((await run(pack => pack.saveConfig({ enabled: false }))).kind).toBe('refused');
  });

  it('reads the machine’s Pack view, and says why when it cannot', async () => {
    const served = fake();
    await mounted(alpha, served.factory);
    await settleUntil(() => readKind() === 'ready', 'the view to be read', runAsync);
    expect(latest?.read.kind === 'ready' && latest.read.view.models).toHaveLength(PACK_VIEW.models.length);

    await shown?.unmount();
    shown = null;
    const failing = fake({
      view: () => {
        throw new Error('unreachable');
      },
    });
    await mounted(alpha, failing.factory);
    await settleUntil(() => readKind() === 'failed', 'the read to fail', runAsync);
  });

  it('is loading while the view is on its way', async () => {
    await mounted(alpha, async () => ({ request: () => new Promise(() => undefined) }) as unknown as FyApiClient);
    expect(readKind()).toBe('loading');
  });

  it('writes pack.yaml against the etag it read, then reads the view again', async () => {
    const served = fake();
    await mounted(alpha, served.factory);
    await settleUntil(() => readKind() === 'ready', 'the view', runAsync);
    expect(await run(pack => pack.saveConfig({ limits: { maxDepth: 3 } }))).toEqual({ kind: 'applied' });
    const put = served.wire.find(call => call.method === 'PUT');
    expect(put?.path).toBe('/v1/config/file');
    expect(put?.body).toMatchObject({ path: 'pack.yaml' });
    expect(JSON.stringify(put?.body)).toContain('maxDepth: 3');
    await settleUntil(() => served.wire.filter(call => call.path === '/v1/pack').length === 2, 're-read', runAsync);
  });

  it('writes the whole guide to models-guide.yaml, and removes it for the built-in one', async () => {
    const served = fake();
    await mounted(alpha, served.factory);
    expect((await run(pack => pack.saveGuide(PACK_VIEW.guide.useCases))).kind).toBe('applied');
    expect((await run(pack => pack.saveGuide(null))).kind).toBe('applied');
    const puts = served.wire.filter(call => call.method === 'PUT');
    expect(puts.map(call => (call.body as { path: string }).path)).toEqual(['models-guide.yaml', 'models-guide.yaml']);
    expect(JSON.stringify(puts[0]?.body)).toContain('claude-opus-5-5');
    expect(JSON.stringify(puts[1]?.body)).not.toContain('useCases');
  });

  it('says plainly when the daemon holds a loosening edit for the owner to confirm', async () => {
    const served = fake({
      put: () => ({
        path: 'pack.yaml',
        etag: 'e2',
        outcome: 'pending',
        pending: { path: 'pack.yaml', etag: 'e2', changes: ['Jev now decides'] },
      }),
    });
    await mounted(alpha, served.factory);
    const result = await run(pack => pack.saveConfig({ decision: 'jev' }));
    expect(result).toEqual({
      kind: 'pending',
      message: 'Saved, but not in effect until you confirm it: Jev now decides.',
    });
    const bare = fake({ put: () => ({ path: 'pack.yaml', etag: 'e2', outcome: 'pending' }) });
    await shown?.unmount();
    shown = null;
    await mounted(alpha, bare.factory);
    expect((await run(pack => pack.saveConfig({ decision: 'jev' }))).kind).toBe('pending');
  });

  it('refuses a file that does not check, and a write the daemon rejects', async () => {
    const broken = fake({ text: 'enabled: maybe\n' });
    await mounted(alpha, broken.factory);
    const result = await run(pack => pack.saveConfig({ enabled: false }));
    expect(result).toEqual({ kind: 'refused', message: 'pack.yaml has a problem; fix it in the Files panel first.' });
    expect(broken.wire.some(call => call.method === 'PUT')).toBe(false);

    await shown?.unmount();
    shown = null;
    const rejecting = fake({
      put: () => {
        throw new Error('boom');
      },
    });
    await mounted(alpha, rejecting.factory);
    expect((await run(pack => pack.saveGuide(null))).kind).toBe('refused');
  });
});
