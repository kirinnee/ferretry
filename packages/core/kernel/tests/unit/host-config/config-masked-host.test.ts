/**
 * S6 / CFG-LEAK-R through a booted host: a ferret's token and a `--limited` device (it holds `fleet.use` only, and
 * reaches the machine over a carrier) each read `mcp/srv.yaml` — a valid file that holds `--token <v>` — through
 * `GET /v1/config/file`, and the ferret through `config_read` too. Gate is stood in for by a stand-in that applies the
 * descriptor honestly and lets every one of them READ: the mask is the kernel's, not Gate's, so it is the same text.
 *
 * `config_read` is a FERRET's door alone (`ferretOfStanding`): a paired device of any grant is refused there, so for the
 * limited device the fourth assertion is that nothing leaves that way either.
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  type Admission,
  type AdmissionDecision,
  AdmissionPort,
  AgentControlPort,
  type ConfigAccessJudgement,
  type ConfigAccessVerdict,
} from '../../../contract/bound.ts';
import { type ApiRequest, errorResponse, headerValue, headersFrom, queryFrom } from '../../../contract/http.ts';
import type { CarrierKey } from '../../../contract/ids.ts';
import type { CallStanding } from '../../../contract/route.ts';
import { bootHost } from '../../../host/host.ts';
import { localArrival } from '../../../host/listener.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { HIDDEN, mcpDef, VALUE } from './masked-support.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
});
const ferrets = definePlugin({
  id: 'ferrets',
  title: 'Ferrets',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { agentControl: AgentControlPort },
  data: { config: [mcpDef] },
});

/** The carrier decides who is at the machine; the header says who calls: `wren` (a ferret), `limited` or `owner`. */
function stoodInGate(grants: ReadonlySet<string>): Admission {
  const refuse = (status: number, code: string): AdmissionDecision => ({
    outcome: 'refused',
    response: errorResponse(status, code, code),
  });
  return {
    admit: input => {
      const descriptor = input.descriptor as unknown as {
        minimum: string;
        privilegedOnly?: boolean;
        capability?: { capability: string; axis: string };
      };
      // Like Gate: a route that says `minimum: 'none'` admits whoever calls; the tool it names then admits the caller.
      if (input.table === 'route' && descriptor.minimum === 'none')
        return { outcome: 'admitted', standing: {} as unknown as CallStanding, actor: 'owner-tools' };
      const arrival = input.request.arrival;
      const onHost = arrival.kind === 'local' && arrival.privileged;
      if (descriptor.privilegedOnly === true && !onHost) return refuse(403, 'forbidden');
      const who = headerValue(input.request, 'x-test-caller');
      if (who === undefined) return refuse(401, 'unauthorized');
      const capability = descriptor.capability;
      if (!onHost && capability !== undefined && !grants.has(`${capability.capability}.${capability.axis}`))
        return refuse(403, 'grant_not_granted');
      const credential =
        who === 'wren'
          ? { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' }
          : { kind: 'authenticated', tokenClass: who === 'limited' ? 'device' : 'admin' };
      return {
        outcome: 'admitted',
        standing: { credential } as unknown as CallStanding,
        actor: who === 'wren' ? 'ferret' : 'owner-tools',
      };
    },
    admitMember: () => {
      throw new Error('no members here');
    },
    readmit: () => true,
    inventory: (_request, entries) => entries,
    // Every one of them may READ; what the read shows is not Gate's to decide.
    judgeConfigAccess: (_input: ConfigAccessJudgement): ConfigAccessVerdict => ({ allowed: true }),
  };
}

const SECRET_FILE = `command: srv\nargs:\n  - --token\n  - ${VALUE}\n`;
const MASKED = `command: srv\nargs:\n  - --token\n  - ${HIDDEN}\n`;

async function boot(text = SECRET_FILE) {
  const root = await mkdtemp(`${tmpdir()}/config-masked-`);
  roots.push(root);
  const home = `${root}/home`;
  const grants = new Set<string>(['fleet.use']);
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(gate, { build: () => ({ provides: { admission: stoodInGate(grants) } }) }),
      implementDaemon(ferrets, { build: () => ({ provides: { agentControl: { allows: async () => true } } }) }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  // A hand-written file, put there after boot: the next read loads it (a daemon sees it by its watcher).
  await mkdir(`${home}/config/mcp`, { recursive: true });
  await writeFile(`${home}/config/mcp/srv.yaml`, text);
  return outcome.host;
}

const call = (
  method: string,
  path: string,
  caller: string,
  relayed: boolean,
  body?: unknown,
  query: readonly [string, string][] = [],
): ApiRequest => ({
  method,
  path,
  query: queryFrom(query),
  headers: headersFrom({ 'x-test-caller': caller }),
  arrival: relayed ? { kind: 'carried', carrier: 'relay' as CarrierKey } : localArrival(true),
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});
const view = (caller: string, relayed: boolean) =>
  call('GET', '/v1/config/file', caller, relayed, undefined, [['path', 'mcp/srv.yaml']]);
const read = (caller: string, relayed: boolean) =>
  call('POST', '/v1/agent/config', caller, relayed, { tool: 'config.read', path: 'mcp/srv.yaml' });
const json = (response: { readonly body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test('S6 CFG-LEAK-R a FERRET token and a --limited device each get the MASKED text from GET /v1/config/file and from config_read', async () => {
  const host = await boot();
  try {
    // The ferret's token, on the host: its own door and the route.
    const ferretGet = await host.dispatch(view('wren', false));
    expect(ferretGet.status).toBe(200);
    expect(json(ferretGet).text).toBe(MASKED);
    expect(ferretGet.body).not.toContain(VALUE);
    const ferretRead = await host.dispatch(read('wren', false));
    expect(ferretRead.status).toBe(200);
    expect(json(ferretRead).text).toBe(MASKED);
    expect(ferretRead.body).not.toContain(VALUE);

    // The limited device, over a carrier with `fleet.use` only: the route shows it the same masked text…
    const limitedGet = await host.dispatch(view('limited', true));
    expect(limitedGet.status).toBe(200);
    expect(json(limitedGet).text).toBe(MASKED);
    expect(limitedGet.body).not.toContain(VALUE);
    // …and `config_read` is a ferret's door alone: a device is refused there, and nothing of the file leaves.
    const limitedRead = await host.dispatch(read('limited', true));
    expect(limitedRead.status).toBeGreaterThanOrEqual(400);
    expect(limitedRead.body).not.toContain(VALUE);
    expect(limitedRead.body).not.toContain('srv');
  } finally {
    await host.stop();
  }
});

test('S6 CFG-LEAK-R the host admin over loopback gets the masked text too: no caller has a raw class', async () => {
  const host = await boot();
  try {
    const response = await host.dispatch(view('owner', false));
    expect(response.status).toBe(200);
    expect(json(response).text).toBe(MASKED);
    expect(response.body).not.toContain(VALUE);
  } finally {
    await host.stop();
  }
});

test('CFG-LEAK-R a withheld file says why in plain words, on the route and at the ferret’s door', async () => {
  // A raw provider key written by hand: withheld whole, and the sentence names the reason and what to do.
  const host = await boot(`note: sk-ant-api03-${'A'.repeat(90)}\n`);
  try {
    for (const response of [await host.dispatch(view('wren', false)), await host.dispatch(view('limited', true))]) {
      expect(response.status).toBe(200);
      const text = String(json(response).text);
      expect(text).toStartWith(`# ${HIDDEN}: the text of this file is not shown because `);
      expect(text).toContain('it holds a raw secret, which the owner must move into the secret store');
      expect(text).toEndWith('; edit it at the machine\n');
      expect(response.body).not.toContain('sk-ant-api03');
    }
    // At the ferret's door the same file is withheld in today's words.
    const door = json(await host.dispatch(read('wren', false)));
    expect(door.text).toBe('');
    expect(String(door.summary)).toContain('its text is not shown because it holds a raw secret');
  } finally {
    await host.stop();
  }
});
