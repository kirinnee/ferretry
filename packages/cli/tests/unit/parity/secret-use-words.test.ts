/**
 * V-0429: `fy secret use`'s words, read the way v4's Commander 15 read them, end to end through `runFy` and the
 * production registry's Vault CLI half over a recording transport standing in for the daemon.
 *
 * Every expectation below was taken from Commander 15.0.0 (the version v4's CLI declared) parsing v4's definition,
 * `.option('-w, --with <name...>').option('--cwd <path>').option('--timeout <ms>').option('--json').argument('<command...>')`:
 * command words may come before `--`; `--` ends option parsing and the words after it are the command's arguments;
 * a variadic `--with` takes every word up to the next option or `--`. Every secret name here is an obvious fake and no
 * value is ever in play: only names and argv reach the daemon.
 */
import { describe, expect, it } from 'bun:test';
import { registry as productionRegistry } from '../../../src/generated/commands.ts';
import { runFy } from '../../../src/lib/run.ts';
import { fakeWorld, inventoryOf } from '../fakes.ts';

const USED = { outcome: 'exited', exitCode: 0, stdout: '', stderr: '', truncated: false, used: [] };

async function use(tokens: readonly string[]) {
  const made = fakeWorld({
    registry: productionRegistry,
    // The daemon this fy was built with: the kernel and every compiled-in plugin on the very contract it carries.
    inventory: inventoryOf(
      { id: 'kernel', contract: productionRegistry.kernel.contract },
      ...productionRegistry.plugins.map(plugin => ({ id: plugin.id, contract: plugin.contract })),
    ),
  });
  made.transport.replies.push({ status: 200, body: USED });
  const code = await runFy(['secret', 'use', ...tokens], made.world);
  const sent = made.transport.sent.find(request => request.path === '/v1/secrets/use');
  return {
    code,
    body: sent?.body as Record<string, unknown> | undefined,
    err: made.io.stderr(),
    out: made.io.stdout(),
  };
}

describe('fy secret use, read as v4 read it', () => {
  it('V-0429 takes command words before -- and appends what follows -- (`printf -- --help`)', async () => {
    const { code, body, err } = await use(['printf', '--', '--help']);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(body).toMatchObject({ command: ['printf', '--help'], secrets: [] });
  });

  it('V-0429 takes a command word before an option and the rest after -- (`printf -w ALPHA -- hello`)', async () => {
    const { code, body, err } = await use(['printf', '-w', 'ALPHA', '--', 'hello']);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(body).toMatchObject({ command: ['printf', 'hello'], secrets: ['ALPHA'] });
  });

  it('V-0429 keeps a name given inline separate from the variadic list (`--with=ALPHA BETA -- true` runs BETA, as v4 did)', async () => {
    const { body } = await use(['--with=ALPHA', 'BETA', '--', 'true']);
    expect(body).toMatchObject({ command: ['BETA', 'true'], secrets: ['ALPHA'] });
  });

  it('V-0429 still reads --with A B -- cmd and -w A -- --flag', async () => {
    const names = await use(['--with', 'ALPHA', 'BETA', '--', 'sh', '-c', 'exit 0']);
    expect(names.body).toMatchObject({ command: ['sh', '-c', 'exit 0'], secrets: ['ALPHA', 'BETA'] });
    const flag = await use(['-w', 'ALPHA', '--', '--flag']);
    expect(flag.body).toMatchObject({ command: ['--flag'], secrets: ['ALPHA'] });
  });

  it('V-0429 reads --json as a switch that takes no value, so a word after it is the command (`--json true`)', async () => {
    const { code, body, err, out } = await use(['--json', 'true']);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(body).toMatchObject({ command: ['true'], secrets: [] });
    expect(out).toContain('"outcome"');
  });

  it('V-0429 refuses a command that was swallowed by --with, or never given, and sends nothing', async () => {
    for (const tokens of [['--with', 'ALPHA', 'sh'], ['-w', 'ALPHA', '--'], ['--json'], []]) {
      const { code, body, err } = await use(tokens);
      expect(code).toBe(1);
      expect(body).toBeUndefined();
      expect(err).toStartWith('error: ');
      expect(err).toContain("missing required argument 'command'");
    }
  });

  it('V-0429 still refuses an unknown option, before --', async () => {
    const { code, body, err } = await use(['--bogus', 'true']);
    expect(code).toBe(1);
    expect(body).toBeUndefined();
    expect(err).toContain("unknown option '--bogus'");
  });
});
