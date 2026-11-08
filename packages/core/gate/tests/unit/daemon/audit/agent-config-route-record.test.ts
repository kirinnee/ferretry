/**
 * R-0244 / T-0034 (round-3 review N2b): an agent's call through `POST /v1/agent/config` is recorded naming the ferret,
 * through a booted kernel host over Gate's REAL `GateAdmission`: the standing comes from the ferret's own bearer, never
 * from the test. The Dispatcher admits the route with no standing (`minimum: 'none'`), so the kernel's handler records
 * the call as the tool the body names, with the standing that tool's declaration was admitted with. The record holds
 * names and ids only: never the text the agent sent.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  type AgentControlKind,
  AgentControlPort,
  AdmissionPort,
  type ApiRequest,
  defineConfig,
} from '@ferretry/kernel/contract';
import { bootHost, realAdapters } from '@ferretry/kernel/host';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { fixedClock } from '@ferretry/kernel/testing';
import { auditKind } from '../../../../contract/index.ts';
import { bearerDigest } from '../../../../daemon/lib/api/authentication.ts';
import { FERRET, FERRET_TOKEN, local, world } from '../support.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A stand-in for a file in the agent's reach (`voice.yaml`); its one rule holds a raised limit. */
const voiceDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10), note: z.string().optional() }),
  axis: 'configure',
  loosens: (before, after) => (after.limit > (before?.limit ?? 10) ? ['raises the limit'] : []),
});
const gateManifest = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
});
const ferretsManifest = definePlugin({
  id: 'ferrets',
  title: 'Ferrets',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { agentControl: AgentControlPort },
  data: { config: [voiceDef] },
});

/** Never a secret: a marker the record must not carry, wherever the body puts it. */
const MARKER = 'body-marker-the-record-never-holds';

async function boot(w: ReturnType<typeof world>) {
  const root = await mkdtemp(`${tmpdir()}/agent-config-record-`);
  roots.push(root);
  const home = `${root}/home`;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(gateManifest, { build: () => ({ provides: { admission: w.gate } }) }),
      implementDaemon(ferretsManifest, {
        build: () => ({
          provides: {
            agentControl: { allows: async (_ferret: string, kind: AgentControlKind) => kind === 'settings' },
          },
        }),
      }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  return outcome.host;
}

const post = (body: unknown): ApiRequest => ({
  method: 'POST',
  path: '/v1/agent/config',
  query: new Map(),
  headers: new Map([['authorization', `Bearer ${FERRET_TOKEN}`]]),
  arrival: local(true),
  text: async () => JSON.stringify(body),
});

test('R-0244 T-0034 a ferret’s write through POST /v1/agent/config is recorded by agent, naming the ferret, never the text', async () => {
  const w = world();
  const host = await boot(w);
  try {
    const written = await host.dispatch(
      post({ tool: 'config.write', path: 'voice.yaml', text: `limit: 5\nnote: ${MARKER}\n` }),
    );
    expect(written.status).toBe(200);
    const read = await host.dispatch(post({ tool: 'config.read', path: 'voice.yaml' }));
    expect(read.status).toBe(200);
    expect(read.body).toContain(MARKER);
    expect(w.recorded).toHaveLength(2);
    for (const draft of w.recorded) {
      expect(draft.event).toBe(auditKind('fleet.configured'));
      expect(draft.outcome).toBe('succeeded');
      expect(draft.detail).toEqual({ action: 'agent-config', by: 'agent', ferret: FERRET, status: 200 });
      expect(draft.actor).not.toEqual({ kind: 'anonymous' });
      expect(JSON.stringify(draft)).not.toContain(MARKER);
    }
  } finally {
    await host.stop();
  }
});

test('R-0244 a call Gate refuses before the handler is recorded as today: no credential, then a revoked ferret token', async () => {
  // Today's audited-route decorator wrapped the whole `POST /v1/agent/config` handler, and the credential check ran
  // inside it, so a 401 and a 403 were recorded `fleet.configured` / `agent-config`, refused, naming nobody (R4 m2).
  const w = world();
  const host = await boot(w);
  try {
    const anonymous = await host.dispatch({ ...post({ tool: 'config.read', note: MARKER }), headers: new Map() });
    expect(anonymous.status).toBe(401);
    expect(w.recorded).toHaveLength(1);

    w.ferrets.revoke(bearerDigest(FERRET_TOKEN));
    const revoked = await host.dispatch(post({ tool: 'config.write', path: 'voice.yaml', text: `note: ${MARKER}\n` }));
    // Exactly one status: Gate refuses a revoked bearer as unauthenticated, before the handler. (Today's handler, which
    // checked the credential itself, answered 403 for a presented credential it could not resolve.)
    expect(revoked.status).toBe(401);
    expect(w.recorded).toHaveLength(2);

    for (const [index, status] of [anonymous.status, revoked.status].entries()) {
      const draft = w.recorded[index];
      expect(draft?.event).toBe(auditKind('fleet.configured'));
      expect(draft?.outcome).toBe('refused');
      expect(draft?.actor).toEqual({ kind: 'anonymous' });
      // Names and ids only: the action and the status, never a ferret it could not prove, a token or the body.
      expect(draft?.detail).toEqual({ action: 'agent-config', status });
    }
    expect(JSON.stringify(w.recorded)).not.toContain(MARKER);
    expect(JSON.stringify(w.recorded)).not.toContain(FERRET_TOKEN);
    expect(JSON.stringify(w.recorded)).not.toContain(bearerDigest(FERRET_TOKEN));
  } finally {
    await host.stop();
  }
});

test('R-0244 a refused body is recorded by agent, naming the ferret, never the body', async () => {
  const w = world();
  const host = await boot(w);
  try {
    const garbage = await host.dispatch(post({ tool: 'nope', note: MARKER }));
    expect(garbage.status).toBe(400);
    expect(w.recorded).toHaveLength(1);
    expect(w.recorded[0]?.detail).toMatchObject({ action: 'agent-config', by: 'agent', ferret: FERRET, status: 400 });
    expect(JSON.stringify(w.recorded)).not.toContain(MARKER);
  } finally {
    await host.stop();
  }
});
