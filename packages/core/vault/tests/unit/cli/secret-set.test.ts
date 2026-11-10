import { describe, expect, it } from 'bun:test';
import type { CliContext, PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

/**
 * `fy secret set` through the real half: the verb the manifest declares, built over a recording client, a fake
 * terminal and a fake stdin. The only values in this file are obvious fakes.
 */
const FAKE = 'fake-secret-000';
const AT = '2026-08-05T10:00:00.000Z';

interface Rig {
  readonly verb: (args: readonly string[], options?: Record<string, string | boolean>) => Promise<number>;
  readonly calls: { route: string; init: unknown }[];
  readonly out: string[];
  readonly err: string[];
  readonly stdinReads: string[];
}

function rig(stdin: string | undefined, refuse?: Error): Rig {
  const calls: { route: string; init: unknown }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stdinReads: string[] = [];
  const client = {
    call: async (route: string, init?: unknown) => {
      calls.push({ route, init });
      if (refuse !== undefined) throw refuse;
      const body = (init as { body: { name: string } }).body;
      return { name: body.name, createdAt: AT, updatedAt: AT };
    },
  } as unknown as PluginClient;
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const ctx: CliContext<typeof manifest> = {
    manifest,
    client,
    io,
    ...(stdin === undefined
      ? {}
      : {
          readText: async (path: string) => {
            stdinReads.push(path);
            return stdin;
          },
        }),
  };
  const half = cli.build?.(ctx);
  const handler = half?.verbs['secret set'];
  if (handler === undefined) throw new Error('the vault cli half answers no `secret set`');
  return {
    verb: async (args, options = {}) => await handler({ args, options }),
    calls,
    out,
    err,
    stdinReads,
  };
}

describe('fy secret set', () => {
  it('S1 reads the value from stdin only and files it under the name, never echoing it', async () => {
    const r = rig(`${FAKE}\n`);
    const code = await r.verb(['ANTHROPIC_KEY']);
    expect(code).toBe(0);
    // The value came from standard input ('-') and nowhere else; one trailing newline was stripped.
    expect(r.stdinReads).toEqual(['-']);
    expect(r.calls).toEqual([{ route: 'POST /v1/secrets', init: { body: { name: 'ANTHROPIC_KEY', value: FAKE } } }]);
    // The answer is the name and an instant; no stream carries the value.
    expect(r.out.join('')).toBe(`ANTHROPIC_KEY stored (${AT})\n`);
    expect([...r.out, ...r.err].join('')).not.toContain(FAKE);
  });

  it('S1 stores nothing and says how to pipe it when stdin is empty', async () => {
    const r = rig('');
    expect(await r.verb(['ANTHROPIC_KEY'])).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.err.join('')).toContain('no value on stdin');
  });

  it('S1 refuses a value too short to mask, without naming it', async () => {
    const r = rig('fake-sh\n');
    expect(await r.verb(['ANTHROPIC_KEY'])).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.err.join('')).toContain('at least 8 characters');
    expect(r.err.join('')).not.toContain('fake-sh');
  });

  it('S1 refuses a name a shell could not export before it reads stdin', async () => {
    const r = rig(`${FAKE}\n`);
    expect(await r.verb(['not-a-name'])).toBe(1);
    expect(r.stdinReads).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it('S1 prints the daemon’s refusal and never the value', async () => {
    const r = rig(`${FAKE}\n`, new Error('the secret store is damaged'));
    expect(await r.verb(['ANTHROPIC_KEY'])).toBe(1);
    expect(r.err.join('')).toBe('error: the secret store is damaged\n');
    expect([...r.out, ...r.err].join('')).not.toContain(FAKE);
  });

  it('S33 has no value argument: a second word is refused and never reaches the daemon', async () => {
    const r = rig(`${FAKE}\n`);
    expect(await r.verb(['ANTHROPIC_KEY', FAKE])).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.stdinReads).toEqual([]);
    expect(r.err.join('')).toContain("too many arguments for 'set'");
    // The refusal names the verb, not the word that was typed after it.
    expect(r.err.join('')).not.toContain(FAKE);
  });

  it('S33 has no value option under any spelling', async () => {
    for (const option of ['value', 'secret', 'v', 'password']) {
      const r = rig(`${FAKE}\n`);
      expect(await r.verb(['ANTHROPIC_KEY'], { [option]: FAKE })).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.err.join('')).toContain('unknown option');
      expect(r.err.join('')).not.toContain(FAKE);
    }
  });

  it('S33 declares one word, the name, and nothing that could carry a value', () => {
    const declared = manifest.actions.cli.filter(each => each.verb === 'secret set');
    expect(declared).toHaveLength(1);
    expect(Object.keys(declared[0] ?? {}).sort()).toEqual(['summary', 'verb']);
  });
});
