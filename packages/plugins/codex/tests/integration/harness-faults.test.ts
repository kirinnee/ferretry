/**
 * What the Codex harness does when the machine under it misbehaves: a binary that will not say its version, an update
 * that ends badly, a launch record that cannot be kept. Each is a closed answer, and none of them stops a launch.
 */
import { describe, it } from 'bun:test';
import type { LaunchSpec, Runner, RunSpec } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import should from 'should';
import { HARNESS_UPDATE_CODES } from '../../contract/index.ts';
import { codexHarness } from '../../daemon/adapters/codex-harness.ts';
import { HarnessUpdateRefusal } from '../../daemon/lib/update/service.ts';
import { realClock } from '../support/ports.ts';
import { selectEverything } from '../support/selected.ts';

const FERRET = 'f1' as FerretId;
const HOME = '/state/codex/agent-homes/f1' as FencedPath;
const FOLDER = '/work/project' as FencedPath;
const LOCATED = {
  outcome: 'located',
  path: '/opt/bin/codex',
  rule: 'inherited environment',
  declaredBy: 'PATH',
} as const;

const handle = {
  name: 'agent-homes',
  resolve: (relative: string) =>
    ok((relative.startsWith('/') ? relative : relative === '' ? HOME : `${HOME}/${relative}`) as FencedPath),
  list: async () => [],
  lstat: async () => undefined,
  makeDirectory: async () => undefined,
  entries: async () => [],
  stat: async () => undefined,
  writeText: async () => undefined,
  ensurePrivateDirectory: async () => undefined,
} as unknown as RootHandle;

type UpdateView = Awaited<ReturnType<Parameters<typeof codexHarness>[0]['update']['view']>>;

function harness(options: {
  readonly version?: Awaited<ReturnType<Parameters<typeof codexHarness>[0]['probe']['version']>>;
  readonly view?: () => Promise<UpdateView>;
  readonly start?: () => Promise<unknown>;
  readonly state?: object;
}) {
  return codexHarness({
    selected: selectEverything,
    kernel: {
      roots: { root: () => handle } as unknown as KernelPorts['roots'],
      state: (options.state ?? { write: async () => undefined }) as never,
      log: { warn: () => undefined } as never,
      clock: realClock(),
      redaction: { read: async fn => await fn({ text: (s: string) => s } as never) },
    },
    locate: async () => LOCATED,
    probe: {
      version: async () => options.version ?? { state: 'ok', version: '0.145.0' },
      startup: async () => ({ ok: true }),
    },
    update: {
      view: options.view ?? (async () => ({}) as UpdateView),
      start: (options.start ?? (async () => undefined)) as never,
      settled: async () => undefined,
    },
  });
}

const finished = (report: object): UpdateView => ({ job: { state: 'finished', report } }) as unknown as UpdateView;

const spec = {
  ferret: FERRET,
  name: 'f1',
  role: 'worker',
  harness: 'codex',
  folder: FOLDER,
  home: HOME,
  instructions: [],
  parts: [],
} as unknown as LaunchSpec;

describe('the Codex harness under a misbehaving machine', () => {
  it('says a binary that will not report a version is not usable, and why', async () => {
    const actual = await harness({ version: { state: 'unreadable', reason: 'it timed out' } }).discover();

    should(actual).eql({
      found: false,
      reason: 'codex at /opt/bin/codex did not report a version (it timed out)',
    });
  });

  it('reports an update that succeeded, with the version it reached', async () => {
    const actual = await harness({
      view: async () => finished({ outcome: 'succeeded', to: '0.150.0', message: 'updated to 0.150.0' }),
    }).update?.();

    should(actual).eql({ updated: true, version: '0.150.0', sentence: 'updated to 0.150.0' });
  });

  it('reports an update that ended without success, with no version', async () => {
    const actual = await harness({
      view: async () => finished({ outcome: 'failed', message: 'the download failed' }),
    }).update?.();

    should(actual).eql({ updated: false, sentence: 'the download failed' });
  });

  it('reports an update that is not finished as not done', async () => {
    const actual = await harness({
      view: async () => ({ job: { state: 'running' } }) as unknown as UpdateView,
    }).update?.();

    should(actual).eql({ updated: false, sentence: 'the update did not finish' });
  });

  it('says a refused update in the refusal’s own words, and lets any other failure through', async () => {
    const refused = await harness({
      start: async () => {
        throw new HarnessUpdateRefusal(HARNESS_UPDATE_CODES.inProgress, 'an update is already running');
      },
    }).update?.();
    const broken = await harness({
      start: async () => {
        throw new Error('the disk is gone');
      },
    })
      .update?.()
      .catch((error: unknown) => error);

    should(refused).eql({ updated: false, sentence: 'an update is already running' });
    should(broken).be.instanceOf(Error);
    should((broken as Error).message).equal('the disk is gone');
  });

  it('still launches when its launch record cannot be kept, or cleared', async () => {
    const started: RunSpec[] = [];
    const runner = {
      key: 'tmux',
      start: async (run: RunSpec) => (started.push(run), ok({ handle: '%1', startedAt: '2026-10-20T09:00:00.000Z' })),
    } as unknown as Runner;
    const recorded: string[] = [];
    const refusing = {
      write: async (def: { name: string }) => {
        if (def.name !== 'rollouts') throw new Error('the record cannot be written');
      },
      remove: async (def: { name: string }) => void recorded.push(def.name),
    };
    const unclearable = {
      write: refusing.write,
      remove: async () => {
        throw new Error('the record cannot be removed either');
      },
    };

    const cleared = await harness({ state: refusing }).start(spec, runner, {} as RunSpec['env']);
    const kept = await harness({ state: unclearable }).start(spec, runner, {} as RunSpec['env']);

    should(cleared.ok).equal(true);
    should(kept.ok).equal(true);
    should(started).have.length(2);
    should(recorded).have.length(1);
  });
});
