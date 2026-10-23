import '../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  PACK_CLEAN_UP_JOBS_PATH,
  PACK_CLEAN_UP_PATH,
  PACK_ROUTING_ACCEPT_PATH,
  PACK_ROUTING_UNDO_PATH,
} from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { z } from 'zod';
import { type MachinePack, type PackSave, useMachinePack } from '../../../../src/features/pack/use-machine-pack.ts';
import type { DaemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { DaemonClientProvider } from '../../../../src/lib/store.tsx';
import { type Mounted, mount } from '../../../support/dom.ts';
import { PACK_VIEW, RUNNING_JOB, SUGGESTION } from '../../../support/pack.ts';
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
  routing = (): unknown => {
    throw new Error('no routing route served');
  },
}: {
  readonly view?: () => unknown;
  readonly text?: string;
  readonly put?: () => unknown;
  /** The answer to a Clean up, accept or undo route, by path. */
  readonly routing?: (path: string) => unknown;
} = {}) => {
  const wire: Wire[] = [];
  const client = {
    request: async (path: string, schema: z.ZodType<unknown>, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      wire.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
      if (path === '/v1/pack') return schema.parse(view());
      if (path.startsWith('/v1/pack/routing')) return schema.parse(routing(path));
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

const remount = async (daemon: DaemonConnection | undefined, factory: ReturnType<typeof fake>['factory']) => {
  await shown?.unmount();
  shown = null;
  await mounted(daemon, factory);
};

const readKind = (): string | null | undefined => shown?.container.querySelector('span')?.getAttribute('data-read');

const run = async <T = PackSave,>(save: (pack: MachinePack) => Promise<T>): Promise<T> => {
  let result: T | null = null;
  await runAsync(async () => {
    result = latest === null ? null : await save(latest);
  });
  if (result === null) throw new Error('no save result');
  return result;
};

const putBodies = (wire: readonly Wire[]) => wire.filter(call => call.method === 'PUT').map(call => call.body);

describe('useMachinePack', () => {
  it('reads nothing without a machine and refuses a save', async () => {
    const served = fake();
    await mounted(undefined, served.factory);
    expect(readKind()).toBe('failed');
    expect(served.wire).toEqual([]);
    expect((await run(pack => pack.saveConfig({ enabled: false }))).kind).toBe('refused');
    expect((await run(pack => pack.savePrompt('Opus.'))).kind).toBe('refused');
  });

  it('reads the machine’s Pack view, and says why when it cannot', async () => {
    const served = fake();
    await mounted(alpha, served.factory);
    await settleUntil(() => readKind() === 'ready', 'the view to be read', runAsync);
    expect(latest?.read.kind === 'ready' && latest.read.view.available).toHaveLength(PACK_VIEW.available.length);

    await remount(
      alpha,
      fake({
        view: () => {
          throw new Error('unreachable');
        },
      }).factory,
    );
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

  it('writes the routing prompt to models-guide.yaml dropping `suggested`, and removes it for the default', async () => {
    const suggested = [
      'prompt: Opus for everything.',
      'suggested:',
      '  by: gpt-6-astra',
      '  via: codex-main',
      '  at: 2026-10-22T14:30:00.000Z',
      '  acceptedAt: 2026-10-22T14:31:00.000Z',
      '',
    ].join('\n');
    const served = fake({ text: suggested });
    await mounted(alpha, served.factory);
    expect((await run(pack => pack.savePrompt('Opus for hard work.'))).kind).toBe('applied');
    expect((await run(pack => pack.savePrompt(null))).kind).toBe('applied');
    const [saved, removed] = putBodies(served.wire) as { path: string; text: string }[];
    expect(saved?.path).toBe('models-guide.yaml');
    expect(saved?.text).toContain('prompt: Opus for hard work.');
    expect(saved?.text).not.toContain('suggested');
    expect(removed?.text).not.toContain('prompt');
    expect(removed?.text).not.toContain('suggested');
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
    await remount(alpha, fake({ put: () => ({ path: 'pack.yaml', etag: 'e2', outcome: 'pending' }) }).factory);
    expect((await run(pack => pack.saveConfig({ decision: 'jev' }))).kind).toBe('pending');
  });

  it('refuses a file that does not check, a prompt that would not, and a write the daemon rejects', async () => {
    const broken = fake({ text: 'enabled: maybe\n' });
    await mounted(alpha, broken.factory);
    const result = await run(pack => pack.saveConfig({ enabled: false }));
    expect(result).toEqual({ kind: 'refused', message: 'pack.yaml has a problem; fix it in the Files panel first.' });
    expect((await run(pack => pack.savePrompt('x'.repeat(1_201)))).kind).toBe('refused');
    expect(broken.wire.some(call => call.method === 'PUT')).toBe(false);

    await remount(
      alpha,
      fake({
        put: () => {
          throw new Error('boom');
        },
      }).factory,
    );
    expect((await run(pack => pack.savePrompt(null))).kind).toBe('refused');
  });
});

describe('useMachinePack › Clean up', () => {
  const started = { outcome: 'started', job: RUNNING_JOB };
  const written = { outcome: 'applied', message: 'Routing prompt saved. Undo keeps the old one.' };

  it('starts a clean-up with exactly what was asked, and reads the view again to find it', async () => {
    const served = fake({ routing: () => started });
    await mounted(alpha, served.factory);
    await settleUntil(() => readKind() === 'ready', 'the view', runAsync);
    const result = await run(pack => pack.cleanUp({ prompt: 'opus for hard stuff' }));
    expect(result).toEqual({ kind: 'started', job: RUNNING_JOB });
    const call = served.wire.find(wire => wire.path === PACK_CLEAN_UP_PATH);
    expect(call).toMatchObject({ method: 'POST', body: { prompt: 'opus for hard stuff' } });
    await settleUntil(() => served.wire.filter(wire => wire.path === '/v1/pack').length === 2, 're-read', runAsync);
  });

  it('says why a start was refused, by the daemon’s answer and by its failure', async () => {
    await mounted(alpha, fake({ routing: () => ({ outcome: 'refused', message: 'No runtime is ready.' }) }).factory);
    expect(await run(pack => pack.cleanUp({}))).toEqual({ kind: 'refused', message: 'No runtime is ready.' });
    await remount(alpha, fake().factory);
    expect((await run(pack => pack.cleanUp({}))).kind).toBe('refused');
  });

  it('reads one run, and says when it cannot', async () => {
    const result = { job: { ...RUNNING_JOB, status: 'suggested' }, suggestion: SUGGESTION };
    const served = fake({ routing: () => result });
    await mounted(alpha, served.factory);
    const read = await run(pack => pack.readJob('job-1'));
    expect(read.kind === 'read' && read.result.suggestion?.suggested.by).toBe('gpt-6-astra');
    expect(served.wire.some(wire => wire.path === `${PACK_CLEAN_UP_JOBS_PATH}/job-1` && wire.method === 'GET')).toBe(
      true,
    );
    await remount(alpha, fake().factory);
    expect((await run(pack => pack.readJob('job-1'))).kind).toBe('failed');
  });

  it('accepts and undoes through their routes, and reads the view again after each', async () => {
    const served = fake({ routing: () => written });
    await mounted(alpha, served.factory);
    await settleUntil(() => readKind() === 'ready', 'the view', runAsync);
    const accept = { prompt: SUGGESTION.after, suggested: SUGGESTION.suggested };
    expect(await run(pack => pack.accept(accept))).toEqual({ kind: 'applied', message: written.message });
    expect((await run(pack => pack.undo())).kind).toBe('applied');
    const calls = served.wire.filter(wire => wire.path.startsWith('/v1/pack/routing'));
    expect(calls.map(wire => wire.path)).toEqual([PACK_ROUTING_ACCEPT_PATH, PACK_ROUTING_UNDO_PATH]);
    expect(calls[0]).toMatchObject({ method: 'POST', body: accept });
    expect(calls[1]).toMatchObject({ method: 'POST', body: undefined });
    await settleUntil(() => served.wire.filter(wire => wire.path === '/v1/pack').length === 3, 're-reads', runAsync);
  });

  it('passes on “nothing to do”, and refuses with the daemon’s words when a write fails', async () => {
    await mounted(
      alpha,
      fake({ routing: () => ({ outcome: 'nothing', message: 'There is nothing to undo.' }) }).factory,
    );
    expect(await run(pack => pack.undo())).toEqual({ kind: 'nothing', message: 'There is nothing to undo.' });
    await remount(alpha, fake().factory);
    expect((await run(pack => pack.undo())).kind).toBe('refused');
  });

  it('refuses every Clean up call without a machine', async () => {
    await mounted(undefined, fake().factory);
    expect((await run(pack => pack.cleanUp({}))).kind).toBe('refused');
    expect((await run(pack => pack.readJob('x'))).kind).toBe('failed');
    expect((await run(pack => pack.accept({ prompt: 'Opus.', suggested: SUGGESTION.suggested }))).kind).toBe('refused');
  });
});
