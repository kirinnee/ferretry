import { describe, expect, it } from 'bun:test';
import type { CliContext, PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

/**
 * `fy secret set` at a terminal: the value is typed hidden (the shell's `promptHidden`, here a fake terminal), never
 * echoed, never written to either stream; piped input keeps its behaviour. The only values here are obvious fakes.
 */
const TYPED = 'typed-fake-secret-000';
const PIPED = 'piped-fake-secret-000';
const AT = '2026-08-05T10:00:00.000Z';

type Hidden = (question: string) => Promise<string | undefined>;

function rig(options: { readonly promptHidden?: Hidden; readonly stdin?: string }) {
  const calls: { route: string; init: unknown }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stdinReads: string[] = [];
  const client = {
    call: async (route: string, init?: unknown) => {
      calls.push({ route, init });
      return { name: (init as { body: { name: string } }).body.name, createdAt: AT, updatedAt: AT };
    },
  } as unknown as PluginClient;
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: true };
  const ctx: CliContext<typeof manifest> = {
    manifest,
    client,
    io,
    ...(options.promptHidden === undefined ? {} : { promptHidden: options.promptHidden }),
    ...(options.stdin === undefined
      ? {}
      : {
          readText: async (path: string) => {
            stdinReads.push(path);
            return options.stdin as string;
          },
        }),
  };
  const handler = cli.build?.(ctx)?.verbs['secret set'];
  if (handler === undefined) throw new Error('the vault cli half answers no `secret set`');
  return {
    run: async (args: readonly string[]) => await handler({ args, options: {} }),
    calls,
    stdinReads,
    text: () => [...out, ...err].join(''),
    err,
  };
}

describe('fy secret set at a terminal', () => {
  it('S1 asks for the value by name, stores what was typed, and never reads standard input', async () => {
    const questions: string[] = [];
    const r = rig({
      promptHidden: async question => {
        questions.push(question);
        return TYPED;
      },
      stdin: `${PIPED}\n`,
    });
    expect(await r.run(['ANTHROPIC_KEY'])).toBe(0);
    expect(questions).toEqual(['value for ANTHROPIC_KEY (hidden; press Enter when done): ']);
    expect(r.calls).toEqual([{ route: 'POST /v1/secrets', init: { body: { name: 'ANTHROPIC_KEY', value: TYPED } } }]);
    expect(r.stdinReads).toEqual([]);
  });

  it('S1 prints the name and an instant, never the typed value, on either stream', async () => {
    const r = rig({ promptHidden: async () => TYPED });
    expect(await r.run(['ANTHROPIC_KEY'])).toBe(0);
    expect(r.text()).toBe(`ANTHROPIC_KEY stored (${AT})\n`);
    expect(r.text()).not.toContain(TYPED);
  });

  it('S1 refuses an empty line and stores nothing', async () => {
    const r = rig({ promptHidden: async () => '' });
    expect(await r.run(['ANTHROPIC_KEY'])).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.err.join('')).toBe('error: no value typed — nothing was stored\n');
  });

  it('S1 refuses a typed value too short to mask, without naming it', async () => {
    const r = rig({ promptHidden: async () => 'short' });
    expect(await r.run(['ANTHROPIC_KEY'])).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.text()).toContain('at least 8 characters');
    expect(r.text()).not.toContain('short\n');
  });

  it('S1 stops with the interrupt’s own exit status when the terminal read is interrupted, and stores nothing', async () => {
    const interrupted = Object.assign(new Error('interrupted'), { exitCode: 130 });
    const r = rig({
      promptHidden: async () => {
        throw interrupted;
      },
    });
    await expect(r.run(['ANTHROPIC_KEY'])).rejects.toBe(interrupted);
    expect(r.calls).toEqual([]);
  });

  it('S1 asks nothing before the name is checked', async () => {
    let asked = false;
    const r = rig({
      promptHidden: async () => {
        asked = true;
        return TYPED;
      },
    });
    expect(await r.run(['not-a-name'])).toBe(1);
    expect(asked).toBe(false);
  });
});

describe('fy secret set with no terminal', () => {
  it('S1 reads standard input to its end and strips one trailing newline, as it always did', async () => {
    const r = rig({ promptHidden: async () => undefined, stdin: `${PIPED}\n\n` });
    expect(await r.run(['ANTHROPIC_KEY'])).toBe(0);
    expect(r.stdinReads).toEqual(['-']);
    expect(r.calls).toEqual([
      { route: 'POST /v1/secrets', init: { body: { name: 'ANTHROPIC_KEY', value: `${PIPED}\n` } } },
    ]);
  });

  it('S1 reads standard input too when the shell offers no hidden prompt', async () => {
    const r = rig({ stdin: PIPED });
    expect(await r.run(['ANTHROPIC_KEY'])).toBe(0);
    expect(r.calls).toHaveLength(1);
  });

  it('S1 keeps the hint for empty piped input', async () => {
    const r = rig({ promptHidden: async () => undefined, stdin: '' });
    expect(await r.run(['ANTHROPIC_KEY'])).toBe(1);
    expect(r.err.join('')).toContain('no value on stdin');
  });
});
