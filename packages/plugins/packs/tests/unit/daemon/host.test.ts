import { describe, expect, test } from 'bun:test';
import type { FerretSummary, LaunchPartSource } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import {
  DEFAULT_PACK_CONFIG,
  FerretResultSchema,
  PACK_CLEAN_UP_PACK,
  PackCleanUpJobResultSchema,
  PackTableSchema,
  PackViewSchema,
  type PacksApi,
  PacksPort,
} from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { LEARNING_MINER_LABEL, WARDEN_LABEL } from '../../../daemon/lib/admission.ts';
import { NO_CLEAN_UP_FOLDER, REWRITE_UNCHECKED } from '../../../daemon/lib/cleanup/service.ts';
import { RESULT_UNCHECKED } from '../../../daemon/lib/result.ts';
import { launchEnvironment, startDecision } from '../../../daemon/lib/hooks.ts';
import manifest from '../../../manifest.ts';

let who: CallStanding = ownerStanding();
const asFerret = (id: string): void => {
  who = ferretStanding(ferretId(id));
};
const asOwner = (): void => {
  who = ownerStanding();
};

async function host(setup: (ferrets: FakeFerrets) => void = () => {}) {
  const ferrets = new FakeFerrets();
  setup(ferrets);
  who = ownerStanding();
  return {
    ferrets,
    host: await testHost({
      plugins: [daemon],
      gate: new StandInAdmission(() => who),
      fakes: { ferrets },
    }),
  };
}

const lead = ferretId('lead');

describe('the start.decide and launch.parts decisions', () => {
  test('a start with no known parent is not refused', () => {
    expect(startDecision(undefined, DEFAULT_PACK_CONFIG.limits)).toEqual({ allow: true });
  });
  test('a parent at its width limit is refused with the sentence and its remedy', () => {
    const decision = startDecision(
      { id: 'lead', interactive: false, depth: 0, runningChildren: DEFAULT_PACK_CONFIG.limits.autoChildren },
      DEFAULT_PACK_CONFIG.limits,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain('already has');
  });
  test('a child that would be too deep is refused', () => {
    const { maxDepth } = DEFAULT_PACK_CONFIG.limits;
    const decision = startDecision(
      { id: 'deep', interactive: true, depth: maxDepth, runningChildren: 0 },
      DEFAULT_PACK_CONFIG.limits,
    );
    expect(decision.allow).toBe(false);
  });
  test('a ferret that is told gets the routing line; one that is not gets only the off flag', async () => {
    const on = await launchEnvironment(
      { ...DEFAULT_PACK_CONFIG, enabled: true },
      { eligible: true, ownSwitch: undefined, depth: 0 },
      async () => 'line',
    );
    expect(on).toEqual({ FY_PACK: '1', FY_PACK_ROUTING: 'line' });
    const off = await launchEnvironment(
      { ...DEFAULT_PACK_CONFIG, enabled: true },
      { eligible: true, ownSwitch: false, depth: 0 },
      async () => {
        throw new Error('not derived for a ferret that is not told');
      },
    );
    expect(off).toEqual({ FY_PACK: '0' });
  });
});

describe('packs on the test host', () => {
  test('GET /v1/pack answers the settings view even with Runtimes and Usage off', async () => {
    const { host: h } = await host();
    const response = await h.request('GET', '/v1/pack');
    expect(response.status).toBe(200);
    expect(PackViewSchema.safeParse(response.json()).success).toBe(true);
    await h.stop();
  });

  test('a finished ferret with no `signal done` message has a result with no summary; an unknown ferret is 404', async () => {
    const { host: h } = await host(ferrets => ferrets.add({ id: lead, state: 'stopped' }));
    const response = await h.request('GET', '/v1/ferrets/lead/result');
    expect(response.status).toBe(200);
    const result = FerretResultSchema.parse(response.json());
    expect([result.finished, result.summary]).toEqual([true, undefined]);
    expect((await h.request('GET', '/v1/ferrets/nobody/result')).status).toBe(404);
    await h.stop();
  });

  test("a lead reads its own pack's table; another ferret may not", async () => {
    const { host: h } = await host(ferrets => {
      ferrets.add({ id: lead });
      ferrets.add({ id: ferretId('kid'), parent: lead, state: 'working' });
      ferrets.add({ id: ferretId('other') });
    });
    asFerret('lead');
    const own = await h.request('GET', '/v1/ferrets/lead/pack');
    expect(own.status).toBe(200);
    const table = PackTableSchema.parse(own.json());
    expect(table.rows.map(row => [row.id, row.depth, row.state])).toEqual([['kid', 1, 'running']]);
    asFerret('other');
    const stranger = await h.request('GET', '/v1/ferrets/lead/pack');
    expect(stranger.status).toBe(403);
    asOwner();
    expect((await h.request('GET', '/v1/ferrets/nobody/pack')).status).toBe(404);
    await h.stop();
  });

  test("a ferret's own switch is kept, read back by `instructed`, and refused for an unknown ferret", async () => {
    const { host: h } = await host(ferrets => ferrets.add({ id: lead, state: 'working' }));
    const packs = h.provided(PacksPort);
    expect(await packs.instructed(lead)).toBe(true);
    const response = await h.request('PATCH', '/v1/ferrets/lead/pack', { body: { enabled: false } });
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      restartRequired: true,
      note: 'Pack mode is off. This ferret is running, so it is told when it restarts; it can start no sub-ferret from now.',
    });
    expect(await packs.instructed(lead)).toBe(false);
    // The same value again changed nothing: no restart is asked for (today's packSwitchNote).
    const again = await h.request('PATCH', '/v1/ferrets/lead/pack', { body: { enabled: false } });
    expect(again.json()).toMatchObject({ restartRequired: false, note: 'Pack mode was already off.' });
    expect((await h.request('PATCH', '/v1/ferrets/nobody/pack', { body: { enabled: true } })).status).toBe(404);
    await h.stop();
  });

  test('accepting a routing prompt says plainly that the configuration writer is not available yet', async () => {
    const { host: h } = await host();
    const response = await h.request('POST', '/v1/pack/routing/accept', {
      body: {
        prompt: 'Use the best model for planning.',
        suggested: { by: 'a model', via: 'a runtime', mode: 'clean-up', at: '2026-11-07T10:00:00.000Z' },
      },
    });
    expect(response.status).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('config_write_unavailable');
    await h.stop();
  });

  test('a ferret cannot start a clean-up, accept or undo: only a person does', async () => {
    const { host: h } = await host(ferrets => ferrets.add({ id: lead }));
    for (const path of ['/v1/pack/routing/clean-up', '/v1/pack/routing/accept', '/v1/pack/routing/undo']) {
      asFerret('lead');
      const response = await h.request('POST', path, { body: {} });
      expect([path, response.status]).toEqual([path, 403]);
    }
    await h.stop();
  });
});

describe('packs: no helper start, and what a finished ferret reported', () => {
  test('Packs answers no start route and offers no `new` or `wait` verb: `fy new` is Ferrets’, `fy wait` Conversation’s', async () => {
    const { host: h } = await host(ferrets => ferrets.add({ id: lead }));
    asFerret('lead');
    const response = await h.request('POST', '/v1/pack/new', { body: { task: 'do it', runtime: 'claude' } });
    expect(response.status).toBe(404);
    const verbs = (manifest.actions?.cli ?? []).map(verb => verb.verb as string);
    expect(verbs).not.toContain('new [words...]');
    expect(verbs).not.toContain('wait <id>');
    expect(verbs).toContain('recommend [task...]');
    expect(manifest.permissions).toEqual({ roots: [], network: [], spawn: [], secrets: [] });
    await h.stop();
  });

  test('R-0170 GET /v1/ferrets/:ferretId/result reads the summary Ferrets keeps (`FerretsApi.summary`), masked', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: lead, state: 'stopped' });
    ferrets.setSummary(lead, 'Fixed the bug; token sk-abc is rotated.\n');
    who = ownerStanding();
    const h = await testHost({
      plugins: [daemon],
      gate: new StandInAdmission(() => who),
      fakes: { ferrets },
      secrets: ['sk-abc'],
    });
    const response = await h.request('GET', '/v1/ferrets/lead/result');
    expect(response.status).toBe(200);
    const result = FerretResultSchema.parse(response.json());
    expect(result.finished).toBe(true);
    expect(result.summary).toBe('Fixed the bug; token ****** is rotated.');
    await h.stop();
  });

  test('Clean up keeps and serves its ferret’s `signal done` rewrite MASKED, inside one Redaction.read', async () => {
    // The kernel's memory state keeps JSON documents only, so the run's opaque files are kept by a stand-in here and the
    // half is built over it: the route, the run store and the result read are the daemon's own. The redactor masks
    // exactly as the test host's `secrets` do (same-width `*`).
    const { ferrets, files } = cleanUpRun('Use the strongest model for plans; key sk-abc.');
    const half = builtHalf(ferrets, files, maskingRedaction(['sk-abc']));

    const response = await jobRoute(half)('run-1');

    expect(response.status).toBe(200);
    expect(response.body).not.toContain('sk-abc');
    const result = PackCleanUpJobResultSchema.parse(JSON.parse(response.body));
    expect(result.job.status).toBe('suggested');
    expect(result.suggestion?.after).toBe('Use the strongest model for plans; key ******.');
    expect(result.suggestion?.before).toBe('Use opus for plans.');
    // What is KEPT is masked too, not only what is served.
    expect(files.get('runs/run-1.run.json')).not.toContain('sk-abc');
    expect(files.get('runs/run-1.run.json')).toContain('******');
  });

  test('Clean up fails closed when the rewrite cannot be masked: the run fails, and no rewrite is kept or served', async () => {
    const { ferrets, files } = cleanUpRun('Use the strongest model for plans; key sk-abc.');
    const half = builtHalf(ferrets, files, failingRedaction());

    const response = await jobRoute(half)('run-1');

    expect(response.status).toBe(200);
    expect(response.body).not.toContain('sk-abc');
    const result = PackCleanUpJobResultSchema.parse(JSON.parse(response.body));
    expect(result.job).toMatchObject({ status: 'failed', message: REWRITE_UNCHECKED });
    expect(result.suggestion).toBeUndefined();
    expect(files.get('runs/run-1.run.json')).not.toContain('sk-abc');
  });

  test('PacksApi.result hands back the summary masked, and withholds it (throws) when masking fails', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: lead, state: 'stopped' });
    ferrets.setSummary(lead, 'Fixed the bug; token sk-abc is rotated.\n');
    const h = await testHost({
      plugins: [daemon],
      gate: new StandInAdmission(() => who),
      fakes: { ferrets },
      secrets: ['sk-abc'],
    });
    expect((await h.provided(PacksPort).result(lead))?.summary).toBe('Fixed the bug; token ****** is rotated.');
    await h.stop();

    const failing = builtHalf(ferrets, new Map(), failingRedaction());
    await expect((failing?.provides?.packs as PacksApi | undefined)?.result(lead) ?? Promise.resolve()).rejects.toThrow(
      RESULT_UNCHECKED,
    );
  });

  test('R-0170 the result route withholds a summary it could not mask (503), never the text', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: lead, state: 'stopped' });
    ferrets.setSummary(lead, 'token sk-abc\n');
    who = ownerStanding();
    const h = await testHost({
      plugins: [daemon],
      gate: new StandInAdmission(() => who),
      fakes: { ferrets },
      redaction: failingRedaction(),
    });
    const response = await h.request('GET', '/v1/ferrets/lead/result');
    expect(response.status).not.toBe(200);
    expect(response.body).not.toContain('sk-abc');
    await h.stop();
  });

  test('Clean up refuses to start, saying why, while no folder for its ferret is handed to Pack mode', async () => {
    const { host: h } = await host();
    const view = PackViewSchema.parse((await h.request('GET', '/v1/pack')).json());
    expect(view.cleanUp).toMatchObject({ available: false, reason: NO_CLEAN_UP_FOLDER });
    const response = await h.request('POST', '/v1/pack/routing/clean-up', { body: {} });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ outcome: 'refused', message: NO_CLEAN_UP_FOLDER });
    await h.stop();
  });
});

describe('packs: a pack table in the reader’s own lineage', () => {
  test('a helper may read its lead’s table, as today', async () => {
    const { host: h } = await host(ferrets => {
      ferrets.add({ id: lead });
      ferrets.add({ id: ferretId('kid'), parent: lead, state: 'working' });
    });
    asFerret('kid');
    const response = await h.request('GET', '/v1/ferrets/lead/pack');
    expect(response.status).toBe(200);
    expect(PackTableSchema.parse(response.json()).rows.map(row => row.id)).toEqual(['kid']);
    await h.stop();
  });
});

/** A redactor that masks `secrets` the way the test host's stand-in does: each one becomes the same width of `*`. */
function maskingRedaction(secrets: readonly string[]) {
  const text = (s: string): string =>
    secrets.reduce((out, secret) => out.split(secret).join('*'.repeat(secret.length)), s);
  return { read: async <T>(fn: (scope: { text(s: string): string }) => T | Promise<T>) => await fn({ text }) } as never;
}

/** A redactor whose vault is unavailable: every read throws. */
function failingRedaction() {
  return {
    read: async () => {
      throw new Error('the vault is unavailable');
    },
  } as never;
}

/** A finished Clean up builder whose `signal done` handed back `prompt`, and its running run as the run store keeps it. */
function cleanUpRun(prompt: string) {
  const builder = ferretId('builder');
  const ferrets = new FakeFerrets();
  ferrets.add({ id: builder, state: 'stopped', pack: PACK_CLEAN_UP_PACK as FerretSummary['pack'] });
  ferrets.setSummary(builder, JSON.stringify({ prompt, notes: [] }));
  const files = new Map<string, string>([
    [
      'runs/run-1.run.json',
      JSON.stringify({
        format: 1,
        job: {
          id: 'run-1',
          ferret: 'builder',
          name: 'Routing Prompt Clean-up',
          runtime: 'claude-work',
          startedAt: '2026-11-07T10:00:00.000Z',
          status: 'running',
        },
      }),
    ],
    ['runs/run-1.rough.txt', 'Use opus for plans.\n'],
  ]);
  return { ferrets, files };
}

/** The half's `GET /v1/pack/routing/jobs/:jobId` handler, called as the dispatcher would. */
function jobRoute(half: ReturnType<typeof builtHalf>) {
  const route = half?.routes?.['GET /v1/pack/routing/jobs/:jobId'] as unknown as (
    call: unknown,
  ) => Promise<{ status: number; body: string }>;
  return async (id: string) => await route({ params: new Map([['jobId', id]]), request: new Request('http://x/') });
}

/** The daemon half built over small stand-ins (opaque state as text by path), to call what Ferrets or a route calls. */
function builtHalf(ferrets: FakeFerrets, files = new Map<string, string>(), redaction: unknown = maskingRedaction([])) {
  const at = (file: { path: string }, name?: string): string => file.path.replace('*', name ?? '');
  const now = '2026-11-07T10:00:00.000Z';
  const half = daemon.build?.({
    manifest,
    needs: { ferrets },
    uses: {
      runtimes: { current: () => undefined },
      usage: { current: () => undefined },
      conversation: { current: () => undefined },
    },
    hooks: {} as never,
    kernel: {
      config: { file: () => undefined },
      state: {
        read: async (file: { path: string }, name?: string) => {
          const text = files.get(at(file, name));
          return { ok: true, value: text === undefined || file.path.includes('*') ? text : JSON.parse(text) };
        },
        update: async (_file: unknown, fn: (current: unknown) => unknown) => ({ ok: true, value: fn(undefined) }),
        write: async (file: { path: string }, value: unknown, name?: string) =>
          void files.set(at(file, name), typeof value === 'string' ? value : JSON.stringify(value)),
        list: async (file: { path: string }) => {
          const prefix = file.path.replace('*', '');
          return [...files.keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length));
        },
        remove: async (file: { path: string }, name?: string) => void files.delete(at(file, name)),
      },
      clock: { now: () => now, nowMs: () => Date.parse(now) },
      ids: { mint: () => 'run-1' },
      redaction,
    } as unknown as DaemonContext<typeof manifest>['kernel'],
  } as DaemonContext<typeof manifest>);
  return half;
}

/** The half's `launch.parts` contribution, as Ferrets calls it at a launch. */
function launchHalf(ferrets: FakeFerrets) {
  const [contribution] = builtHalf(ferrets)?.hooks?.['launch.parts']() ?? [];
  return contribution?.item as LaunchPartSource;
}

describe('packs launch.parts: the daemon’s own workers are never told about Pack mode (no unattended spend)', () => {
  const launch = async (extra: Partial<FerretSummary>) => {
    const ferrets = new FakeFerrets();
    const id = ferretId('f1');
    ferrets.add({ id, mode: 'auto', ...extra });
    return await launchHalf(ferrets).parts({ ferret: id } as never);
  };

  test('an ordinary ferret is told: FY_PACK=1 and the routing line', async () => {
    const [part] = await launch({});
    expect(part).toMatchObject({ kind: 'env', env: { FY_PACK: '1' } });
    expect((part as { env: Record<string, string> }).env.FY_PACK_ROUTING).toBeString();
  });

  test('the learning miner (by its label) launches with FY_PACK=0 and no routing line', async () => {
    expect(await launch({ label: LEARNING_MINER_LABEL })).toEqual([{ kind: 'env', env: { FY_PACK: '0' } }]);
  });

  test('the Clean up builder (its hidden pack or its label) launches with FY_PACK=0', async () => {
    expect(await launch({ pack: PACK_CLEAN_UP_PACK as FerretSummary['pack'] })).toEqual([
      { kind: 'env', env: { FY_PACK: '0' } },
    ]);
    expect(await launch({ label: PACK_CLEAN_UP_PACK })).toEqual([{ kind: 'env', env: { FY_PACK: '0' } }]);
  });

  test('a warden, its helper and that helper’s own (started with --label fleet-warden, then by parent) launch with FY_PACK=0', async () => {
    // The chain is made by Ferrets starts, as 5.0 records them: the label from the start options, the lineage from
    // `parent`. No provenance stamp is written by any 5.0 start, so none is given here.
    const ferrets = new FakeFerrets();
    const start = async (request: Partial<Parameters<FakeFerrets['start']>[0]>) => {
      const started = await ferrets.start({ folder: '/work/project', by: 'owner', ...request });
      if (!started.ok) throw new Error(started.error.reason);
      return started.value;
    };
    const warden = await start({ options: { label: WARDEN_LABEL, mode: 'auto' } });
    const investigator = await start({ parent: warden, by: 'ferret' });
    const helper = await start({ parent: investigator, by: 'ferret' });
    const ordinary = await start({});
    expect((await ferrets.get(warden))?.label).toBe(WARDEN_LABEL);
    expect((await ferrets.get(warden)) as unknown as { provenance?: unknown }).not.toHaveProperty('provenance');

    const half = builtHalf(ferrets);
    const [contribution] = half?.hooks?.['launch.parts']() ?? [];
    const parts = contribution?.item as LaunchPartSource;
    for (const id of [warden, investigator, helper])
      expect([id, await parts.parts({ ferret: id } as never)]).toEqual([id, [{ kind: 'env', env: { FY_PACK: '0' } }]]);
    expect(await parts.parts({ ferret: ordinary } as never)).toMatchObject([{ kind: 'env', env: { FY_PACK: '1' } }]);

    // `PacksApi.instructed` reads the same walk.
    const packs = half?.provides?.packs as PacksApi | undefined;
    expect(await packs?.instructed(helper)).toBe(false);
    expect(await packs?.instructed(ordinary)).toBe(true);
  });
});
