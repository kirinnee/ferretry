import { describe, expect, it } from 'bun:test';
import type { PluginClient, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import { TUNNEL_OFF_SENTENCE } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';

const view = { enabled: false, explicit: false, state: 'off', tunnelUrl: null, sentence: TUNNEL_OFF_SENTENCE };
type Verbs = Record<string, (invocation: VerbInvocation) => Promise<number>>;

/** The REAL cli half, built the way the fy shell builds it, over a fake daemon client. */
function realVerbs(client: PluginClient, io: { out(t: string): void; err(t: string): void; isTty: boolean }): Verbs {
  if (cli.build === undefined) throw new Error('the connections cli half has no build');
  return cli.build({ manifest, client, io }).verbs as Verbs;
}

describe('tunnel CLI', () => {
  function harness() {
    const calls: unknown[] = [];
    const lines: string[] = [];
    const client = {
      call: async (route: string, init: unknown) => {
        calls.push({ route, init });
        return view;
      },
      subscribe: () => () => undefined,
    } as PluginClient;
    return {
      calls,
      lines,
      verbs: realVerbs(client, { out: text => lines.push(text), err: () => undefined, isTty: false }),
    };
  }
  it('every verb the manifest declares has a handler in the real cli half', () => {
    expect(Object.keys(harness().verbs).toSorted()).toEqual(manifest.actions.cli.map(decl => decl.verb).toSorted());
  });
  it('R657 changes the daemon switch and reports that it applied without restart', async () => {
    const { calls, lines, verbs } = harness();
    expect(await verbs['tunnel on']!({ args: [], options: {} })).toBe(0);
    expect(await verbs['tunnel off']!({ args: [], options: {} })).toBe(0);
    expect(calls).toEqual([
      { route: 'PUT /v1/tunnel', init: { body: { enabled: true } } },
      { route: 'PUT /v1/tunnel', init: { body: { enabled: false } } },
    ]);
    expect(lines.every(line => line.endsWith('Applied without a restart.'))).toBe(true);
  });
  it('V-0248 status renders the parsed live view as text or JSON', async () => {
    const { verbs, lines } = harness();
    await verbs['tunnel status']!({ args: [], options: {} });
    await verbs['tunnel status']!({ args: [], options: { json: true } });
    expect(lines).toEqual([TUNNEL_OFF_SENTENCE, JSON.stringify(view)]);
  });
  it('V-0245 the bare tunnel verb is declared and shows the live status, as status does', async () => {
    const { calls, lines, verbs } = harness();
    expect(manifest.actions.cli.map(decl => decl.verb)).toContain('tunnel');
    expect(await verbs.tunnel!({ args: [], options: {} })).toBe(0);
    expect(await verbs.tunnel!({ args: [], options: { json: true } })).toBe(0);
    expect(calls).toEqual([
      { route: 'GET /v1/tunnel', init: undefined },
      { route: 'GET /v1/tunnel', init: undefined },
    ]);
    expect(lines).toEqual([TUNNEL_OFF_SENTENCE, JSON.stringify(view)]);
  });
  it('an invalid daemon answer is refused rather than printed', async () => {
    const verbs = realVerbs({ call: async () => ({}), subscribe: () => () => undefined } as PluginClient, {
      out: () => {
        throw new Error('printed');
      },
      err: () => undefined,
      isTty: false,
    });
    await expect(verbs['tunnel status']!({ args: [], options: {} })).rejects.toThrow();
  });
});
