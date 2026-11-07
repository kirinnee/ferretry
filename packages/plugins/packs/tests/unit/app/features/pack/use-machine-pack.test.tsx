import '../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import type { PackRoutingWriteResult } from '../../../../../contract/index.ts';
import { type MachinePack, type PackSave, useMachinePack } from '../../../../../app/features/pack/use-machine-pack.ts';
import type { PacksClient } from '../../../../../app/lib/client.ts';
import type { ConfigFilePutResult, ConfigFiles } from '../../../../../app/lib/pack-config.ts';
import { type Mounted, mount } from '../../../support/dom.ts';
import { kernelConfigText } from '../../../support/config-text.ts';
import { PACK_VIEW, RUNNING_JOB, SUGGESTION } from '../../../support/pack.ts';
import { settleUntil } from '../../../support/settle.ts';
import { interact } from '../../../support/dom.ts';

interface Wire {
  readonly key: string;
  readonly init: unknown;
}

/** Serves the daemon's routes and the shell's configuration files; every call is recorded. */
const fake = ({
  view = (): unknown => PACK_VIEW,
  text = '',
  put = (): ConfigFilePutResult => ({ outcome: 'applied' }),
  routing = (): unknown => {
    throw new Error('no routing route served');
  },
}: {
  readonly view?: () => unknown;
  readonly text?: string;
  readonly put?: () => ConfigFilePutResult;
  /** The answer to a Clean up, accept, undo or job route, by route key. */
  readonly routing?: (key: string) => unknown;
} = {}) => {
  const wire: Wire[] = [];
  const written: { path: string; text: string; etag: string }[] = [];
  const client: PacksClient = {
    call: async (key: string, init?: unknown) => {
      wire.push({ key, init });
      if (key === 'GET /v1/pack') return view();
      return routing(key);
    },
  } as PacksClient;
  const files: ConfigFiles = {
    text: kernelConfigText,
    read: async () => ({ text, etag: 'e1' }),
    write: async (path, body, etag) => {
      written.push({ path, text: body, etag });
      return put();
    },
  };
  return { wire, written, client, files };
};

let shown: Mounted | null = null;
let latest: MachinePack | null = null;

afterEach(async () => {
  await shown?.unmount();
  shown = null;
  latest = null;
});

function Probe({ served }: { readonly served: ReturnType<typeof fake> }) {
  latest = useMachinePack(served.client, served.files);
  return <span data-read={latest.read.kind} />;
}

const mounted = async (served: ReturnType<typeof fake>) => {
  shown = await mount(<Probe served={served} />);
};

const remount = async (served: ReturnType<typeof fake>) => {
  await shown?.unmount();
  shown = null;
  await mounted(served);
};

const readKind = (): string | null | undefined => shown?.container.querySelector('span')?.getAttribute('data-read');

const run = async <T = PackSave>(save: (pack: MachinePack) => Promise<T>): Promise<T> => {
  let result: T | null = null;
  await interact(async () => {
    result = latest === null ? null : await save(latest);
  });
  if (result === null) throw new Error('no save result');
  return result;
};

const reads = (wire: readonly Wire[]) => wire.filter(call => call.key === 'GET /v1/pack').length;

describe('useMachinePack', () => {
  it('reads the machine’s Pack view, and says why when it cannot', async () => {
    const served = fake();
    await mounted(served);
    await settleUntil(() => readKind() === 'ready', 'the view to be read', interact);
    expect(latest?.read.kind === 'ready' && latest.read.view.available).toHaveLength(PACK_VIEW.available.length);

    await remount(
      fake({
        view: () => {
          throw new Error('unreachable');
        },
      }),
    );
    await settleUntil(() => readKind() === 'failed', 'the read to fail', interact);
  });

  it('is loading while the view is on its way', async () => {
    const served = fake();
    const never: PacksClient = { call: () => new Promise(() => undefined) } as PacksClient;
    shown = await mount(<Probe served={{ ...served, client: never }} />);
    expect(readKind()).toBe('loading');
  });

  it('writes packs.yaml against the digest it read, then reads the view again', async () => {
    const served = fake();
    await mounted(served);
    await settleUntil(() => readKind() === 'ready', 'the view', interact);
    expect(await run(pack => pack.saveConfig({ limits: { maxDepth: 3 } }))).toEqual({ kind: 'applied' });
    expect(served.written).toHaveLength(1);
    expect(served.written[0]?.path).toBe('packs.yaml');
    expect(served.written[0]?.etag).toBe('e1');
    expect(served.written[0]?.text).toContain('maxDepth: 3');
    await settleUntil(() => reads(served.wire) === 2, 're-read', interact);
  });

  it('writes the routing prompt into packs.yaml dropping `suggested`, and removes it for the default', async () => {
    const suggested = [
      'routing:',
      '  prompt: Opus for everything.',
      '  suggested:',
      '    by: gpt-6-astra',
      '    via: codex-main',
      '    at: 2026-10-22T14:30:00.000Z',
      '    acceptedAt: 2026-10-22T14:31:00.000Z',
      '',
    ].join('\n');
    const served = fake({ text: suggested });
    await mounted(served);
    expect((await run(pack => pack.savePrompt('Opus for hard work.'))).kind).toBe('applied');
    expect((await run(pack => pack.savePrompt(null))).kind).toBe('applied');
    const [saved, removed] = served.written;
    expect(saved?.path).toBe('packs.yaml');
    expect(saved?.text).toContain('prompt: Opus for hard work.');
    expect(saved?.text).not.toContain('suggested');
    expect(removed?.text).not.toContain('prompt');
    expect(removed?.text).not.toContain('suggested');
  });

  it('says plainly when the daemon holds a loosening edit for the owner to confirm', async () => {
    const served = fake({ put: () => ({ outcome: 'pending', changes: ['Jev now decides'] }) });
    await mounted(served);
    const result = await run(pack => pack.saveConfig({ decision: 'jev' }));
    expect(result).toEqual({
      kind: 'pending',
      message: 'Saved, but not in effect until you confirm it: Jev now decides.',
    });
  });

  it('refuses a file that does not check, a prompt that would not, and a write the daemon rejects', async () => {
    const broken = fake({ text: 'enabled: maybe\n' });
    await mounted(broken);
    const result = await run(pack => pack.saveConfig({ enabled: false }));
    expect(result).toEqual({ kind: 'refused', message: 'packs.yaml has a problem; fix it in the Files panel first.' });
    expect((await run(pack => pack.savePrompt('x'.repeat(1_201)))).kind).toBe('refused');
    expect(broken.written).toEqual([]);

    await remount(
      fake({
        put: () => {
          throw new Error('boom');
        },
      }),
    );
    expect((await run(pack => pack.savePrompt(null))).kind).toBe('refused');
  });
});

describe('useMachinePack › Clean up', () => {
  const started = { outcome: 'started', job: RUNNING_JOB };
  const written: PackRoutingWriteResult = {
    outcome: 'applied',
    message: 'Routing prompt saved. Undo keeps the old one.',
  };

  it('starts a clean-up with exactly what was asked, and reads the view again to find it', async () => {
    const served = fake({ routing: () => started });
    await mounted(served);
    await settleUntil(() => readKind() === 'ready', 'the view', interact);
    const result = await run(pack => pack.cleanUp({ prompt: 'opus for hard stuff' }));
    expect(result).toEqual({ kind: 'started', job: RUNNING_JOB });
    const call = served.wire.find(wire => wire.key === 'POST /v1/pack/routing/clean-up');
    expect(call?.init).toEqual({ body: { prompt: 'opus for hard stuff' } });
    await settleUntil(() => reads(served.wire) === 2, 're-read', interact);
  });

  it('says why a start was refused, by the daemon’s answer and by its failure', async () => {
    await mounted(fake({ routing: () => ({ outcome: 'refused', message: 'No runtime is ready.' }) }));
    expect(await run(pack => pack.cleanUp({}))).toEqual({ kind: 'refused', message: 'No runtime is ready.' });
    await remount(fake());
    expect((await run(pack => pack.cleanUp({}))).kind).toBe('refused');
  });

  it('reads one run, and says when it cannot', async () => {
    const result = { job: { ...RUNNING_JOB, status: 'suggested' }, suggestion: SUGGESTION };
    const served = fake({ routing: () => result });
    await mounted(served);
    const read = await run(pack => pack.readJob('job-1'));
    expect(read.kind === 'read' && read.result.suggestion?.suggested.by).toBe('gpt-6-astra');
    expect(served.wire.some(wire => wire.key === 'GET /v1/pack/routing/jobs/:jobId')).toBe(true);
    await remount(fake());
    expect((await run(pack => pack.readJob('job-1'))).kind).toBe('failed');
  });

  it('accepts and undoes through their routes, and reads the view again after each', async () => {
    const served = fake({ routing: () => written });
    await mounted(served);
    await settleUntil(() => readKind() === 'ready', 'the view', interact);
    const accept = { prompt: SUGGESTION.after, suggested: SUGGESTION.suggested };
    expect(await run(pack => pack.accept(accept))).toEqual({ kind: 'applied', message: written.message });
    expect((await run(pack => pack.undo())).kind).toBe('applied');
    const calls = served.wire.filter(wire => wire.key.startsWith('POST /v1/pack/routing'));
    expect(calls.map(wire => wire.key)).toEqual(['POST /v1/pack/routing/accept', 'POST /v1/pack/routing/undo']);
    expect(calls[0]?.init).toEqual({ body: accept });
    await settleUntil(() => reads(served.wire) === 3, 're-reads', interact);
  });

  it('passes on “nothing to do”, and refuses with the daemon’s words when a write fails', async () => {
    await mounted(fake({ routing: () => ({ outcome: 'nothing', message: 'There is nothing to undo.' }) }));
    expect(await run(pack => pack.undo())).toEqual({ kind: 'nothing', message: 'There is nothing to undo.' });
    await remount(fake());
    expect((await run(pack => pack.undo())).kind).toBe('refused');
  });
});
