/**
 * R-0072 / R-0419 / R-0274 through a booted host: `GET /v1/config/file`, `PUT /v1/config/file` and
 * `POST /v1/config/confirm` are dispatched with `host.dispatch`, so the manifest's descriptors (operator minimum,
 * `caller: 'person'`, `fleet.use`) reach admission as declared and the real handlers run over the real config writer.
 * Gate is stood in for by a stand-in that applies the descriptor honestly: a loopback caller (a privileged local
 * arrival) is ungoverned; an arrival that came over a carrier — a RELAYED loopback included — is remote, so it needs
 * the capability the descriptor names; a route that says `caller: 'person'` refuses a ferret's credential.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  type Admission,
  type AdmissionDecision,
  AdmissionPort,
  type ConfigAccessJudgement,
  type ConfigAccessVerdict,
} from '../../../contract/bound.ts';
import { defineConfig } from '../../../contract/index.ts';
import { type ApiRequest, errorResponse, headerValue, headersFrom, queryFrom } from '../../../contract/http.ts';
import type { CarrierKey } from '../../../contract/ids.ts';
import type { CallStanding } from '../../../contract/route.ts';
import { bootHost } from '../../../host/host.ts';
import { localArrival } from '../../../host/listener.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const voiceDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10) }),
  axis: 'configure',
  loosens: (before, after) =>
    after.limit > (before?.limit ?? 10) ? [`raises the limit from ${before?.limit ?? 10} to ${after.limit}`] : [],
});

const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
  data: { config: [voiceDef] },
});

interface Standing {
  readonly onHost: boolean;
  readonly ferret: boolean;
}

/** The descriptor the host handed admission, per call: what the stand-in judged against. */
interface Asked {
  readonly path: string;
  readonly minimum: string;
  readonly caller: string | undefined;
  readonly capability: unknown;
}

/**
 * Who calls is `x-test-caller` (`owner` or the ferret `wren`); WHERE from is the arrival. Remote (carried) callers hold
 * only the capabilities in `grants`.
 */
function stoodInGate(grants: Set<string>, asked: Asked[]): Admission {
  const refuse = (status: number, code: string): AdmissionDecision => ({
    outcome: 'refused',
    response: errorResponse(status, code, code),
  });
  return {
    admit: input => {
      const descriptor = input.descriptor as unknown as {
        method: string;
        path: string;
        minimum: string;
        caller?: string;
        capability?: { capability: string; axis: string };
      };
      asked.push({
        path: `${descriptor.method} ${descriptor.path}`,
        minimum: descriptor.minimum,
        caller: descriptor.caller,
        capability: descriptor.capability,
      });
      const who = headerValue(input.request, 'x-test-caller');
      if (who === undefined) return refuse(401, 'unauthorized');
      const arrival = input.request.arrival;
      const onHost = arrival.kind === 'local' && arrival.privileged;
      const ferret = who === 'wren';
      if (descriptor.caller === 'person' && ferret) return refuse(403, 'person_only');
      const capability = descriptor.capability;
      // Somebody at the machine is ungoverned; a carried arrival, relayed loopback included, holds only what is granted.
      if (!onHost && capability !== undefined && !grants.has(`${capability.capability}.${capability.axis}`))
        return refuse(403, 'grant_not_granted');
      const standing: Standing = { onHost, ferret };
      return {
        outcome: 'admitted',
        standing: standing as unknown as CallStanding,
        actor: ferret ? 'ferret' : 'owner-tools',
      };
    },
    admitMember: () => {
      throw new Error('no members here');
    },
    readmit: () => true,
    inventory: (_request, entries) => entries,
    judgeConfigAccess: (input: ConfigAccessJudgement): ConfigAccessVerdict => {
      const standing = input.standing as unknown as Standing | undefined;
      if (input.act === 'read') return { allowed: true };
      // A loosening is put into effect at once only for somebody at this machine; nobody here holds a passkey proof.
      return { allowed: true, mayLoosen: standing?.onHost === true, claimLoosening: () => false };
    },
  };
}

async function boot() {
  const root = await mkdtemp(`${tmpdir()}/config-routes-host-`);
  roots.push(root);
  const home = `${root}/home`;
  const grants = new Set<string>();
  const asked: Asked[] = [];
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(gate, { build: () => ({ provides: { admission: stoodInGate(grants, asked) } }) }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  return { host: outcome.host, grants, asked, file: `${home}/config/voice.yaml` };
}

type Where = 'host' | 'relay';

function call(
  method: string,
  path: string,
  options: {
    readonly caller?: string;
    readonly where?: Where;
    readonly query?: readonly [string, string][];
    readonly body?: unknown;
  } = {},
): ApiRequest {
  return {
    method,
    path,
    query: queryFrom(options.query ?? []),
    headers: headersFrom(options.caller === undefined ? {} : { 'x-test-caller': options.caller }),
    arrival: options.where === 'relay' ? { kind: 'carried', carrier: 'relay' as CarrierKey } : localArrival(true),
    text: async () => (options.body === undefined ? '' : JSON.stringify(options.body)),
  };
}

const json = (response: { readonly body: string }) => JSON.parse(response.body) as Record<string, unknown>;
const view = (path = 'voice.yaml', where: Where = 'host', caller = 'owner') =>
  call('GET', '/v1/config/file', { caller, where, query: [['path', path]] });
const put = (text: string, where: Where = 'host', caller = 'owner', etag?: string) =>
  call('PUT', '/v1/config/file', {
    caller,
    where,
    body: { path: 'voice.yaml', text, ...(etag === undefined ? {} : { etag }) },
  });
const confirm = (etag: string, where: Where = 'host', caller = 'owner') =>
  call('POST', '/v1/config/confirm', { caller, where, body: { path: 'voice.yaml', etag } });

test('R-0072 GET /v1/config/file through the host: the owner at the machine reads the file; a ferret is admitted (any caller)', async () => {
  const { host, asked } = await boot();
  try {
    const response = await host.dispatch(view());
    expect(response.status).toBe(200);
    expect(json(response)).toMatchObject({
      path: 'voice.yaml',
      kind: 'gate',
      exists: false,
      etag: 'absent',
      state: 'ok',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    // The descriptor admission judged is the manifest's: operator minimum, any caller, fleet.use.
    expect(asked.at(-1)).toEqual({
      path: 'GET /v1/config/file',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'use' },
    });
    const ferret = await host.dispatch(view('voice.yaml', 'host', 'wren'));
    expect(ferret.status).toBe(200);
  } finally {
    await host.stop();
  }
});

test('R-0072 GET /v1/config/file through the host: no credential is 401, and a RELAYED caller is remote — refused until fleet.use is granted, then served', async () => {
  const { host, grants } = await boot();
  try {
    expect((await host.dispatch(call('GET', '/v1/config/file', { query: [['path', 'voice.yaml']] }))).status).toBe(401);
    const refused = await host.dispatch(view('voice.yaml', 'relay'));
    expect(refused.status).toBe(403);
    expect(json(refused).code).toBe('grant_not_granted');
    expect(refused.body).not.toContain('limit');
    grants.add('fleet.use');
    const served = await host.dispatch(view('voice.yaml', 'relay'));
    expect(served.status).toBe(200);
    // Not a file any plugin declares: 400, not a read.
    expect((await host.dispatch(view('nope.yaml'))).status).toBe(400);
  } finally {
    await host.stop();
  }
});

test('R-0419 PUT /v1/config/file through the host: a ferret is refused (person only) and nothing is written; the owner at the machine writes', async () => {
  const { host, asked, file } = await boot();
  try {
    const ferret = await host.dispatch(put('limit: 5\n', 'host', 'wren'));
    expect(ferret.status).toBe(403);
    expect(json(ferret).code).toBe('person_only');
    expect(asked.at(-1)).toEqual({
      path: 'PUT /v1/config/file',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'fleet', axis: 'use' },
    });
    await expect(readFile(file, 'utf8')).rejects.toThrow();
    const owner = await host.dispatch(put('limit: 5\n'));
    expect(owner.status).toBe(200);
    expect(json(owner)).toMatchObject({ path: 'voice.yaml', outcome: 'applied' });
    expect(await readFile(file, 'utf8')).toBe('limit: 5\n');
  } finally {
    await host.stop();
  }
});

test('R-0419 PUT /v1/config/file through the host: a RELAYED owner is remote — refused without fleet.use, and a loosening is HELD, not applied', async () => {
  const { host, grants, file } = await boot();
  try {
    expect((await host.dispatch(put('limit: 5\n', 'host'))).status).toBe(200);
    const refused = await host.dispatch(put('limit: 50\n', 'relay'));
    expect(refused.status).toBe(403);
    expect(await readFile(file, 'utf8')).toBe('limit: 5\n');
    grants.add('fleet.use');
    const held = json(await host.dispatch(put('limit: 50\n', 'relay')));
    expect(held.outcome).toBe('pending');
    expect(held.pending).toMatchObject({ path: 'voice.yaml', changes: ['raises the limit from 5 to 50'] });
    // The text is on disk for the owner to review; the tighter version stays in effect.
    expect(await readFile(file, 'utf8')).toBe('limit: 50\n');
    const read = json(await host.dispatch(view()));
    expect(read.state).toBe('pending');
    // The same loosening from somebody at the machine is put into effect at once.
    const local = json(await host.dispatch(put('limit: 60\n', 'host', 'owner', String(read.etag))));
    expect(local.outcome).toBe('applied');
  } finally {
    await host.stop();
  }
});

test('R-0419 PUT /v1/config/file through the host: a stale etag is 409, an extra body key 400, a file that does not check 422 with nothing written', async () => {
  const { host, file } = await boot();
  try {
    expect((await host.dispatch(put('limit: 5\n'))).status).toBe(200);
    const stale = await host.dispatch(put('limit: 4\n', 'host', 'owner', 'stale'));
    expect(stale.status).toBe(409);
    expect(json(stale).code).toBe('config_conflict');
    const extra = await host.dispatch(
      call('PUT', '/v1/config/file', { caller: 'owner', body: { path: 'voice.yaml', text: '', extra: 1 } }),
    );
    expect(extra.status).toBe(400);
    const read = json(await host.dispatch(view()));
    const broken = await host.dispatch(put('limit: many\n', 'host', 'owner', String(read.etag)));
    expect(broken.status).toBe(422);
    expect(json(broken).code).toBe('config_invalid');
    expect(await readFile(file, 'utf8')).toBe('limit: 5\n');
  } finally {
    await host.stop();
  }
});

test('R-0274 POST /v1/config/confirm through the host: a ferret is refused (person only); the owner confirms the reviewed held edit and it takes effect', async () => {
  const { host, asked, grants } = await boot();
  try {
    expect((await host.dispatch(put('limit: 5\n'))).status).toBe(200);
    grants.add('fleet.use');
    const held = json(await host.dispatch(put('limit: 50\n', 'relay')));
    expect(held.outcome).toBe('pending');
    const etag = String(held.etag);
    const ferret = await host.dispatch(confirm(etag, 'host', 'wren'));
    expect(ferret.status).toBe(403);
    expect(json(ferret).code).toBe('person_only');
    expect(asked.at(-1)).toEqual({
      path: 'POST /v1/config/confirm',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'fleet', axis: 'use' },
    });
    // Still held after the ferret's attempt.
    expect(json(await host.dispatch(view())).state).toBe('pending');
    const confirmed = await host.dispatch(confirm(etag));
    expect(confirmed.status).toBe(200);
    expect(json(confirmed)).toEqual({ path: 'voice.yaml', confirmed: true });
    expect(json(await host.dispatch(view())).state).toBe('ok');
  } finally {
    await host.stop();
  }
});

test('R-0274 POST /v1/config/confirm through the host: a RELAYED caller needs fleet.use, an etag nobody reviewed confirms nothing, and the body names a path and an etag only', async () => {
  const { host, grants } = await boot();
  try {
    expect((await host.dispatch(put('limit: 5\n'))).status).toBe(200);
    grants.add('fleet.use');
    const held = json(await host.dispatch(put('limit: 50\n', 'relay')));
    grants.delete('fleet.use');
    const refused = await host.dispatch(confirm(String(held.etag), 'relay'));
    expect(refused.status).toBe(403);
    expect(json(refused).code).toBe('grant_not_granted');
    const unreviewed = await host.dispatch(confirm('not-the-edit-that-waits'));
    expect(json(unreviewed)).toEqual({ path: 'voice.yaml', confirmed: false });
    expect(json(await host.dispatch(view())).state).toBe('pending');
    const bare = await host.dispatch(
      call('POST', '/v1/config/confirm', { caller: 'owner', body: { path: 'voice.yaml' } }),
    );
    expect(bare.status).toBe(400);
    expect(
      (await host.dispatch(call('POST', '/v1/config/confirm', { body: { path: 'voice.yaml', etag: 'x' } }))).status,
    ).toBe(401);
  } finally {
    await host.stop();
  }
});
