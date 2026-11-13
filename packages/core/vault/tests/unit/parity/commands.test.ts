/**
 * The Vault's V rows of docs/design/rebuild-parity.tsv that are `fy secret …` verbs, each named by its id: the real CLI
 * half (`cli/index.ts`) built over a recording client, a fake terminal and a fake standard input. The one test that
 * needs the daemon's masking answers through the REAL secret services (directory, vault, use) over in-memory
 * documents, so what it proves is what a daemon would send. Every value in this file is an obvious fake.
 */
import { describe, expect, it } from 'bun:test';
import type { Clock } from '@ferretry/kernel/contract';
import type { CliContext, PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import { type SecretList, SecretListSchema, SecretUseRequestSchema } from '../../../contract/index.ts';
import { ChildEnvironments } from '../../../daemon/lib/secrets/child-environments.ts';
import { SecretUseService } from '../../../daemon/lib/secrets/use.ts';
import { SecretDirectory, SecretVault } from '../../../daemon/lib/secrets/vault.ts';
import manifest from '../../../manifest.ts';
import { EchoSecretChildRunner, FakeSecretCipher, MemorySecretDocuments } from '../daemon/support.ts';

const AT = '2026-08-05T10:00:00.000Z';
const LATER = '2026-08-06T10:00:00.000Z';
const FAKE = 'fake-secret-value-000';

type Call = { readonly route: string; readonly init: Record<string, unknown> | undefined };
type Answer = (call: Call) => unknown;

interface Rig {
  readonly run: (verb: string, args?: readonly string[], options?: VerbInvocation['options']) => Promise<number>;
  readonly calls: Call[];
  readonly out: string[];
  readonly err: string[];
  readonly text: () => string;
}

function rig(answer: Answer, options: { readonly stdin?: string; readonly pwd?: string } = {}): Rig {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client = {
    call: async (route: string, init?: Record<string, unknown>) => {
      const call = { route, init };
      calls.push(call);
      return answer(call);
    },
  } as unknown as PluginClient;
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const ctx: CliContext<typeof manifest> = {
    manifest,
    client,
    io,
    ...(options.stdin === undefined ? {} : { readText: async () => options.stdin as string }),
    ...(options.pwd === undefined ? {} : { env: { PWD: options.pwd } }),
  };
  const half = cli.build?.(ctx);
  return {
    run: async (verb, args = [], opts = {}) => {
      const verbs = (half?.verbs ?? {}) as Record<string, ((i: VerbInvocation) => Promise<number>) | undefined>;
      const handler = verbs[verb];
      if (handler === undefined) throw new Error(`the vault cli half answers no \`${verb}\``);
      return await handler({ args, options: opts });
    },
    calls,
    out,
    err,
    text: () => [...out, ...err].join(''),
  };
}

const LIST: SecretList = SecretListSchema.parse({
  v: 1,
  health: 'ready',
  secrets: [
    { name: 'ANTHROPIC_KEY', createdAt: AT, updatedAt: AT },
    { name: 'DEPLOY_TOKEN', createdAt: AT, updatedAt: LATER },
  ],
  references: [{ name: 'MISSING_ONE', origin: 'config/vault.yaml → env.API', resolved: false }],
});

describe('fy secret ls', () => {
  it('V-0426 lists names and when they changed, names an unresolved reference, and prints no value', async () => {
    const r = rig(() => LIST);
    expect(await r.run('secret ls')).toBe(0);
    expect(r.calls.map(call => call.route)).toEqual(['GET /v1/secrets']);
    const printed = r.out.join('');
    expect(printed).toContain(`  ANTHROPIC_KEY  set ${AT}\n`);
    expect(printed).toContain(`  DEPLOY_TOKEN  changed ${LATER}\n`);
    expect(printed).toContain('MISSING_ONE  ← config/vault.yaml → env.API');
    expect(printed).toContain('Agents can USE these without holding one');
    expect(r.err).toEqual([]);
  });

  it('V-0426 says so, and says the store is NOT empty, when the daemon cannot read it', async () => {
    const r = rig(() => ({ ...LIST, health: 'damaged', diagnosis: 'the key does not open the store', secrets: [] }));
    expect(await r.run('secret ls')).toBe(0);
    expect(r.out.join('')).toContain('This daemon cannot read its secret store.');
    expect(r.out.join('')).toContain('the key does not open the store');
    expect(r.out.join('')).toContain('It is NOT empty.');
  });

  it('V-0426 says there are none when there are none', async () => {
    const r = rig(() => ({ ...LIST, secrets: [], references: [] }));
    expect(await r.run('secret ls')).toBe(0);
    expect(r.out.join('')).toContain('No secrets on this daemon.');
  });

  it('V-0426 --json prints the protocol document, and any other option is refused before the daemon is asked', async () => {
    const r = rig(() => LIST);
    expect(await r.run('secret ls', [], { json: true })).toBe(0);
    expect(JSON.parse(r.out.join(''))).toEqual(LIST);
    const refused = rig(() => LIST);
    expect(await refused.run('secret ls', [], { value: FAKE })).toBe(1);
    expect(refused.calls).toEqual([]);
    expect(refused.err.join('')).toBe("error: unknown option '--value'\n");
    expect(refused.text()).not.toContain(FAKE);
  });

  it('V-0426 refuses an answer that is not the protocol listing instead of printing it', async () => {
    const r = rig(() => ({ secrets: [{ name: 'ANTHROPIC_KEY', value: FAKE }] }));
    expect(await r.run('secret ls')).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.text()).not.toContain(FAKE);
  });
});

describe('fy secret rm', () => {
  it('V-0427 deletes the named secret and says which', async () => {
    const r = rig(() => ({ name: 'ANTHROPIC_KEY', removed: true }));
    expect(await r.run('secret rm', ['ANTHROPIC_KEY'])).toBe(0);
    expect(r.calls).toEqual([{ route: 'DELETE /v1/secrets/:name', init: { params: { name: 'ANTHROPIC_KEY' } } }]);
    expect(r.out.join('')).toBe('ANTHROPIC_KEY removed\n');
  });

  it('V-0427 refuses a name a shell could not export, and a missing or extra word, before the daemon is asked', async () => {
    const r = rig(() => ({}));
    expect(await r.run('secret rm', ['not-a-name'])).toBe(1);
    expect(r.err.join('')).toContain('is not a usable secret name');
    expect(await r.run('secret rm', [])).toBe(1);
    expect(r.err.join('')).toContain("missing required argument 'name'");
    expect(await r.run('secret rm', ['A_NAME', 'B_NAME'])).toBe(1);
    expect(r.err.join('')).toContain("too many arguments for 'rm'");
    expect(r.calls).toEqual([]);
  });

  it('V-0427 prints the daemon’s refusal as an error and exits 1', async () => {
    const r = rig(() => {
      throw new Error('no secret named ANTHROPIC_KEY');
    });
    expect(await r.run('secret rm', ['ANTHROPIC_KEY'])).toBe(1);
    expect(r.err.join('')).toBe('error: no secret named ANTHROPIC_KEY\n');
  });
});

describe('fy secret set', () => {
  it('V-0428 reads the value from stdin, files it under the name and never echoes it', async () => {
    const r = rig(
      call => ({ name: (call.init as { body: { name: string } }).body.name, createdAt: AT, updatedAt: AT }),
      {
        stdin: `${FAKE}\n`,
      },
    );
    expect(await r.run('secret set', ['ANTHROPIC_KEY'])).toBe(0);
    expect(r.calls).toEqual([{ route: 'POST /v1/secrets', init: { body: { name: 'ANTHROPIC_KEY', value: FAKE } } }]);
    expect(r.out.join('')).toBe(`ANTHROPIC_KEY stored (${AT})\n`);
    expect(r.text()).not.toContain(FAKE);
  });
});

const USED = { outcome: 'exited', exitCode: 0, stdout: '', stderr: '', truncated: false, used: [] } as const;

describe('fy secret use', () => {
  it('V-0429 sends the command, the secret NAMES and the working directory, and relays the child verbatim', async () => {
    const r = rig(() => ({ ...USED, stdout: 'out line\n', stderr: 'err line\n', used: ['ANTHROPIC_KEY'] }), {
      pwd: '/work/app',
    });
    expect(await r.run('secret use', ['curl', '-H', 'x', 'https://example.test'], { with: 'ANTHROPIC_KEY' })).toBe(0);
    expect(r.calls).toEqual([
      {
        route: 'POST /v1/secrets/use',
        init: {
          body: {
            command: ['curl', '-H', 'x', 'https://example.test'],
            cwd: '/work/app',
            secrets: ['ANTHROPIC_KEY'],
            env: {},
            timeoutMs: 60_000,
          },
        },
      },
    ]);
    // Byte for byte: no colour, no appended newline of ours.
    expect(r.out).toEqual(['out line\n']);
    expect(r.err).toEqual(['err line\n']);
  });

  it('V-0429 takes --with repeated or as -w, --cwd and --timeout, and refuses a bad name or timeout before any call', async () => {
    const r = rig(() => USED);
    expect(
      await r.run('secret use', ['true'], { with: ['A_KEY', 'B_KEY'], w: 'C_KEY', cwd: '/srv', timeout: '5000' }),
    ).toBe(0);
    const sent = r.calls[0]?.init as { body: { secrets: string[]; cwd: string; timeoutMs: number } } | undefined;
    const body = sent?.body;
    expect(body).toMatchObject({ secrets: ['A_KEY', 'B_KEY', 'C_KEY'], cwd: '/srv', timeoutMs: 5000 });
    const bad = rig(() => USED);
    expect(await bad.run('secret use', ['true'], { with: 'nope', cwd: '/srv' })).toBe(1);
    expect(await bad.run('secret use', ['true'], { timeout: '0', cwd: '/srv' })).toBe(1);
    expect(await bad.run('secret use', ['true'], { timeout: 'soon', cwd: '/srv' })).toBe(1);
    expect(bad.calls).toEqual([]);
    expect(bad.err.join('')).toContain('is not a usable secret name');
    expect(bad.err.join('')).toContain('--timeout must be a positive whole millisecond');
  });

  it('V-0429 exits with the child’s own status, and 125 when it never ran or was stopped', async () => {
    const run = async (answer: Record<string, unknown>) => {
      const r = rig(() => ({ ...USED, ...answer }), { pwd: '/work' });
      return { code: await r.run('secret use', ['sh']), r };
    };
    expect((await run({ exitCode: 3 })).code).toBe(3);
    const timeout = await run({ outcome: 'timeout', exitCode: undefined });
    expect(timeout.code).toBe(125);
    expect(timeout.r.err.join('')).toContain('the command did not finish in time and was stopped');
    const spawn = await run({ outcome: 'spawn_failed', exitCode: undefined });
    expect(spawn.code).toBe(125);
    expect(spawn.r.err.join('')).toContain('the command could not be started');
    const truncated = await run({ truncated: true });
    expect(truncated.code).toBe(0);
    expect(truncated.r.err.join('')).toContain('(output was truncated by the daemon)');
  });

  it('V-0429 --json prints the protocol result instead of relaying the streams', async () => {
    const r = rig(() => ({ ...USED, stdout: 'hello\n', used: ['A_KEY'] }), { pwd: '/work' });
    expect(await r.run('secret use', ['echo'], { json: true })).toBe(0);
    expect(JSON.parse(r.out.join(''))).toMatchObject({ outcome: 'exited', stdout: 'hello\n', used: ['A_KEY'] });
  });

  it('V-0429 refuses no command, no working directory and an unknown option, without calling the daemon', async () => {
    const r = rig(() => USED);
    expect(await r.run('secret use', [], { cwd: '/srv' })).toBe(1);
    expect(r.err.join('')).toContain("missing required argument 'command'");
    expect(await r.run('secret use', ['true'])).toBe(1);
    expect(r.err.join('')).toContain('no working directory — pass --cwd <absolute path>');
    expect(await r.run('secret use', ['true'], { cwd: '/srv', env: 'A=B' })).toBe(1);
    expect(r.err.join('')).toContain("unknown option '--env'");
    expect(r.calls).toEqual([]);
  });
});

describe('what the secret verbs print', () => {
  it('V-0426 V-0429 print no secret value: ls names the secret, a use answers its masked output, through the real services', async () => {
    const clock = { now: () => AT } as unknown as Clock;
    const documents = new MemorySecretDocuments();
    const cipher = new FakeSecretCipher();
    const directory = new SecretDirectory(documents, cipher, clock);
    await directory.put('DEPLOY_TOKEN', FAKE);
    const vault = new SecretVault(documents, cipher);
    const environments = new ChildEnvironments();
    // The child prints its whole environment, as a careless script would.
    const runner = new EchoSecretChildRunner(environments);
    const service = new SecretUseService(vault, runner, environments);
    const r = rig(
      async ({ route, init }) => {
        if (route === 'GET /v1/secrets')
          return { v: 1, health: 'ready', secrets: await directory.list(), references: [] };
        if (route === 'POST /v1/secrets/use')
          return await service.run(SecretUseRequestSchema.parse((init as { body: unknown }).body));
        throw new Error(`unexpected ${route}`);
      },
      { pwd: '/work' },
    );

    expect(await r.run('secret ls')).toBe(0);
    expect(await r.run('secret ls', [], { json: true })).toBe(0);
    expect(await r.run('secret use', ['env'], { with: 'DEPLOY_TOKEN' })).toBe(0);
    expect(await r.run('secret use', ['env'], { with: 'DEPLOY_TOKEN', json: true })).toBe(0);

    // The child really was given the value, in ITS environment only…
    expect(runner.opened).toEqual({ DEPLOY_TOKEN: FAKE });
    // …and nothing any verb printed holds it.
    expect(r.text()).toContain('DEPLOY_TOKEN');
    expect(r.text()).toContain('[redacted');
    expect(r.text()).not.toContain(FAKE);
  });
});

describe('fy secret (bare)', () => {
  it('V-0397 lists, as fy secret ls does, and takes the same one option', async () => {
    const r = rig(() => LIST);
    expect(await r.run('secret')).toBe(0);
    expect(r.calls.map(call => call.route)).toEqual(['GET /v1/secrets']);
    expect(r.out.join('')).toContain(`  ANTHROPIC_KEY  set ${AT}`);
    expect(await r.run('secret', [], { value: FAKE })).toBe(1);
    expect(r.text()).not.toContain(FAKE);
  });
});
