import '../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  PACK_GUIDE_ACCEPT_PATH,
  PACK_GUIDE_DESCRIBE_PATH,
  PACK_GUIDE_SUGGEST_PATH,
  PACK_GUIDE_UNDO_PATH,
  packGuideJobPath,
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
  guide = (): unknown => {
    throw new Error('no generator route served');
  },
}: {
  readonly view?: () => unknown;
  readonly text?: string;
  readonly put?: () => unknown;
  /** The answer to a generator route, by path. */
  readonly guide?: (path: string) => unknown;
} = {}) => {
  const wire: Wire[] = [];
  const client = {
    request: async (path: string, schema: z.ZodType<unknown>, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      wire.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
      if (path === '/v1/pack') return schema.parse(view());
      if (path.startsWith('/v1/pack/guide')) return schema.parse(guide(path));
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

const run = async <T = PackSave,>(save: (pack: MachinePack) => Promise<T>): Promise<T> => {
  let result: T | null = null;
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

describe('useMachinePack › the guide generator', () => {
  const started = { outcome: 'started', job: RUNNING_JOB };
  const written = { outcome: 'applied', message: 'Guide saved. Undo keeps the old one.' };

  it('starts a builder with exactly what was asked, and reads the view again to find it', async () => {
    const served = fake({ guide: () => started });
    await mounted(alpha, served.factory);
    await settleUntil(() => readKind() === 'ready', 'the view', runAsync);
    const result = await run(pack => pack.suggest({ runtime: 'codex-main', preferences: 'Cheap first.' }));
    expect(result).toEqual({ kind: 'started', job: RUNNING_JOB });
    const call = served.wire.find(wire => wire.path === PACK_GUIDE_SUGGEST_PATH);
    expect(call).toMatchObject({ method: 'POST', body: { runtime: 'codex-main', preferences: 'Cheap first.' } });
    await settleUntil(() => served.wire.filter(wire => wire.path === '/v1/pack').length === 2, 're-read', runAsync);
  });

  it('says why a start was refused, by the daemon’s answer and by its failure', async () => {
    const refused = fake({ guide: () => ({ outcome: 'refused', message: 'No runtime is ready.' }) });
    await mounted(alpha, refused.factory);
    expect(await run(pack => pack.suggest({}))).toEqual({ kind: 'refused', message: 'No runtime is ready.' });
    await shown?.unmount();
    shown = null;
    const failing = fake();
    await mounted(alpha, failing.factory);
    expect((await run(pack => pack.suggest({}))).kind).toBe('refused');
  });

  it('reads one run, and says when it cannot', async () => {
    const result = { job: { ...RUNNING_JOB, status: 'suggested' }, suggestion: SUGGESTION };
    const served = fake({ guide: () => result });
    await mounted(alpha, served.factory);
    const read = await run(pack => pack.readJob('job-1'));
    expect(read.kind === 'read' && read.result.suggestion?.suggested.by).toBe('gpt-6-astra');
    expect(served.wire.some(wire => wire.path === packGuideJobPath('job-1') && wire.method === 'GET')).toBe(true);
    await shown?.unmount();
    shown = null;
    await mounted(alpha, fake().factory);
    expect((await run(pack => pack.readJob('job-1'))).kind).toBe('failed');
  });

  it('accepts, undoes and describes through their routes, and reads the view again after each', async () => {
    const served = fake({ guide: () => written });
    await mounted(alpha, served.factory);
    await settleUntil(() => readKind() === 'ready', 'the view', runAsync);
    const accept = { useCases: [...PACK_VIEW.guide.useCases], suggested: SUGGESTION.suggested, partial: true };
    expect(await run(pack => pack.acceptGuide(accept))).toEqual({ kind: 'applied', message: written.message });
    expect((await run(pack => pack.undoGuide())).kind).toBe('applied');
    expect((await run(pack => pack.describeModel({ model: 'glm-5.3', description: null }))).kind).toBe('applied');
    const paths = served.wire.filter(wire => wire.path.startsWith('/v1/pack/guide'));
    expect(paths.map(wire => wire.path)).toEqual([
      PACK_GUIDE_ACCEPT_PATH,
      PACK_GUIDE_UNDO_PATH,
      PACK_GUIDE_DESCRIBE_PATH,
    ]);
    expect(paths[0]?.body).toEqual(accept);
    expect(paths[1]).toMatchObject({ method: 'POST', body: undefined });
    expect(paths[2]?.body).toEqual({ model: 'glm-5.3', description: null });
    await settleUntil(() => served.wire.filter(wire => wire.path === '/v1/pack').length === 4, 're-reads', runAsync);
  });

  it('passes on “nothing to do”, and refuses with the daemon’s words when a write fails', async () => {
    const nothing = fake({ guide: () => ({ outcome: 'nothing', message: 'There is nothing to undo.' }) });
    await mounted(alpha, nothing.factory);
    expect(await run(pack => pack.undoGuide())).toEqual({ kind: 'nothing', message: 'There is nothing to undo.' });
    await shown?.unmount();
    shown = null;
    await mounted(alpha, fake().factory);
    expect((await run(pack => pack.undoGuide())).kind).toBe('refused');
  });

  it('refuses every generator call without a machine', async () => {
    await mounted(undefined, fake().factory);
    expect((await run(pack => pack.suggest({}))).kind).toBe('refused');
    expect((await run(pack => pack.readJob('x'))).kind).toBe('failed');
    expect((await run(pack => pack.acceptGuide({ useCases: [], suggested: SUGGESTION.suggested }))).kind).toBe(
      'refused',
    );
  });

  it('writes routing guidance with the guide only when asked', async () => {
    const served = fake();
    await mounted(alpha, served.factory);
    await run(pack => pack.saveGuide(PACK_VIEW.guide.useCases, { prompt: 'Opus first.', short: 'Opus first' }));
    await run(pack => pack.saveGuide(PACK_VIEW.guide.useCases));
    const puts = served.wire.filter(call => call.method === 'PUT').map(call => JSON.stringify(call.body));
    expect(puts[0]).toContain('Opus first.');
    expect(puts[1]).not.toContain('routing');
  });
});
