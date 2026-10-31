import { describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  bunCheckSpawn,
  type CheckRun,
  type CheckSpawn,
  CliConversionCheck,
  CliHarnessVersion,
  inOrder,
} from '../../../src/adapters/transcript/conversion-check.ts';
import { LoopbackModel, requestTexts, requestToolNames } from '../../../src/adapters/transcript/loopback-model.ts';
import type { ConversionPlace } from '../../../src/lib/migrate/conversation-convert.ts';
import type { ConversionResult } from '../../../src/lib/transcript/convert/convert.ts';

/**
 * The validation run a conversion must pass, with the CLI stood in by a spawn that behaves like one:
 * it opens the file the check wrote where the real CLI would look, and sends the loopback model the
 * history it found. The real CLIs are measured in the harness contract suite
 * (`packages/fleet/tests/contract/conversion-acceptance.test.ts`).
 */

type Spawned = Parameters<CheckSpawn>[0];

/** A rendering with these sentinels and native tools, whose transcript is `text`. */
const rendering =
  (text: string, sentinels: readonly string[], nativeTools: readonly string[] = []) =>
  (place: ConversionPlace): ConversionResult => ({
    kind: 'converted',
    transcript: `${text} ${place.conversationId} ${place.cwd} ${place.modelProvider ?? ''}`,
    files: [],
    summary: {} as never,
    sentinels,
    nativeTools,
  });

/** A stand-in CLI: it records how it was run, then POSTs `body` to the model the env points it at. */
function cli(
  body: (spawned: Spawned) => Record<string, unknown> | undefined,
  exitCode: number | null = 0,
  output = '',
): { readonly spawn: CheckSpawn; readonly seen: Spawned[]; readonly files: string[] } {
  const seen: Spawned[] = [];
  const files: string[] = [];
  const spawn: CheckSpawn = async spawned => {
    seen.push(spawned);
    const home = spawned.env.CLAUDE_CONFIG_DIR ?? spawned.env.CODEX_HOME ?? '';
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else files.push(`${path.slice(home.length)}=${await readFile(path, 'utf8')}`);
      }
    };
    await walk(home);
    const payload = body(spawned);
    const base =
      spawned.env.ANTHROPIC_BASE_URL ??
      /base_url = "([^"]+)"/u.exec(files.find(file => file.includes('config.toml')) ?? '')?.[1]?.replace(/\/v1$/u, '');
    if (payload !== undefined && base !== undefined)
      await fetch(`${base}/v1/${spawned.env.ANTHROPIC_BASE_URL === undefined ? 'responses' : 'messages'}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    return { exitCode, output } satisfies CheckRun;
  };
  return { spawn, seen, files };
}

const claudeHistory = (...texts: string[]) => ({
  model: 'm',
  tools: [{ name: 'Bash' }],
  messages: texts.map(text => ({ role: 'user', content: [{ type: 'text', text }] })),
});

describe('CliConversionCheck', () => {
  it('should resume a Claude rendering in a throwaway home and accept it when the history arrives in order', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'fy-check-test-'));
    const fake = cli(() => claudeHistory('first', 'second'));
    const subject = new CliConversionCheck(fake.spawn, '/usr/bin:/bin', 5_000, root);

    // Act
    const verdict = await subject.check({
      harness: 'claude',
      executable: '/opt/claude/bin/claude',
      model: 'claude-opus-5-5',
      render: rendering('claude-file', ['first', 'second'], ['Bash']),
    });

    // Assert
    should(verdict).deepEqual({ ok: true });
    const run = fake.seen[0] as Spawned;
    should(run.cmd.slice(0, 4)).deepEqual(['/opt/claude/bin/claude', '-p', '--resume', run.cmd[3] as string]);
    should(run.cmd.slice(4)).deepEqual(['--model', 'claude-opus-5-5', 'Reply with the single word OK.']);
    should(run.env).match({ ANTHROPIC_API_KEY: 'fy-conversion-check-not-a-key', HTTPS_PROXY: 'http://127.0.0.1:9' });
    should(run.env.PATH).equal('/opt/claude/bin:/usr/bin:/bin');
    should(fake.files).have.length(1);
    should(fake.files[0]).match(new RegExp(`^/projects/.*-work/${run.cmd[3]}\\.jsonl=claude-file ${run.cmd[3]} `, 'u'));
    // The throwaway home is gone afterwards.
    should(await readdir(root)).deepEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it('should resume a Codex rendering against its own provider entry, under the model the runtime will run', async () => {
    // Arrange
    const fake = cli(() => ({ tools: [{ name: 'exec_command' }, {}], input: [{ content: [{ text: 'only' }] }] }));
    const subject = new CliConversionCheck(fake.spawn, '/usr/bin');

    // Act
    const verdict = await subject.check({
      harness: 'codex',
      executable: '/opt/codex/codex',
      model: 'gpt-5.5',
      render: rendering('codex-file', ['only'], ['exec_command']),
    });
    const unmodelled = await new CliConversionCheck(cli(() => undefined).spawn).check({
      harness: 'codex',
      executable: '/opt/codex/codex',
      render: rendering('codex-file', []),
    });

    // Assert
    should(verdict).deepEqual({ ok: true });
    const run = fake.seen[0] as Spawned;
    should(run.cmd).deepEqual([
      '/opt/codex/codex',
      'exec',
      '--skip-git-repo-check',
      'resume',
      run.cmd[4] as string,
      'Reply with the single word OK.',
    ]);
    const config = fake.files.find(file => file.startsWith('/config.toml=')) ?? '';
    should(config).containEql('model_provider = "fy_check"');
    should(config).containEql('model = "gpt-5.5"');
    should(fake.files.find(file => file.startsWith('/sessions/'))).match(/codex-file .* fy_check$/u);
    // No model call at all is a refusal too: the CLI never got as far as reading its history.
    should(unmodelled.ok).be.false();
  });

  it('should refuse, in plain words, every way a CLI can fail to read the converted conversation', async () => {
    // Arrange
    const render = rendering('file', ['first', 'second'], ['Bash']);
    const run = async (fake: ReturnType<typeof cli>, check = render) =>
      await new CliConversionCheck(fake.spawn).check({ harness: 'claude', executable: '/bin/claude', render: check });

    // Act
    const verdicts = [
      await run(cli(() => undefined, null, 'still starting')),
      await run(cli(() => claudeHistory('first', 'second'), 1, 'line one\nError: No conversation found\n\n')),
      await run(cli(() => claudeHistory('second', 'first'))),
      await run(cli(() => ({ ...claudeHistory('first', 'second'), tools: [] }))),
      await run(cli(() => ({ messages: 'not a list' }))),
      await run(
        cli(() => claudeHistory()),
        () => ({ kind: 'refused', reason: 'Too new.' }),
      ),
    ];

    // Assert
    should(verdicts).deepEqual([
      {
        ok: false,
        reason: "Claude Code didn't finish opening the converted conversation in time. It said: still starting",
      },
      {
        ok: false,
        reason:
          'Claude Code refused to open the converted conversation. It said: line one / Error: No conversation found',
      },
      {
        ok: false,
        reason:
          "Claude Code opened the converted conversation but didn't read its history back in order, so it would lose context.",
      },
      {
        ok: false,
        reason: "The converted history uses Bash, which this Claude Code doesn't offer as a tool.",
        missingTools: ['Bash'],
      },
      {
        ok: false,
        reason:
          "Claude Code opened the converted conversation but didn't read its history back in order, so it would lose context.",
      },
      { ok: false, reason: 'Too new.' },
    ]);
  });

  it('should say which CLI it was when Codex refuses', async () => {
    // Act
    const verdict = await new CliConversionCheck(cli(() => undefined, 2).spawn).check({
      harness: 'codex',
      executable: '/bin/codex',
      render: rendering('file', []),
    });

    // Assert
    should(verdict).deepEqual({ ok: false, reason: 'Codex refused to open the converted conversation.' });
  });
});

describe('the sentinel order', () => {
  it('should find each sentinel only after the one before it', () => {
    // Act + Assert
    should(inOrder('a b c', ['a', 'c'])).be.true();
    should(inOrder('a b c', ['c', 'a'])).be.false();
    should(inOrder('aa', ['a', 'a'])).be.true();
    should(inOrder('a', ['a', 'a'])).be.false();
    should(inOrder('', [])).be.true();
  });
});

describe('LoopbackModel', () => {
  it('should answer both wire protocols with a streamed OK, record model calls only, and stop', async () => {
    // Arrange
    const model = new LoopbackModel();
    const port = model.start();
    const post = async (path: string, body: unknown) =>
      await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body) });

    // Act
    const messages = await post('/v1/messages', { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
    const responses = await post('/v1/responses', { input: [] });
    const side = await post('/v1/models', {});
    const garbled = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: 'not json' });
    const messagesText = await messages.text();
    const responsesText = await responses.text();
    await garbled.text();
    model.stop();
    model.stop();

    // Assert
    should(messages.headers.get('content-type')).equal('text/event-stream');
    should(messagesText).containEql('"text":"OK"');
    should(messagesText).containEql('event: message_stop');
    should(responsesText).containEql('event: response.completed');
    should(await side.json()).deepEqual({ data: [], models: [] });
    should(model.requests).have.length(3);
    should(model.requests[2]).deepEqual({});
  });

  it('should read back the history and tools a request carried, in either protocol', () => {
    // Act + Assert
    should(
      requestTexts({
        messages: [
          { role: 'user', content: 'plain' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'said' },
              { type: 'tool_use', input: {} },
            ],
          },
          { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'result' }] }] },
          'junk',
        ],
      }),
    ).equal('plain\nsaid\nresult');
    should(
      requestTexts({
        input: [
          { type: 'message', content: [{ text: 'in' }] },
          { type: 'function_call_output', output: 'out' },
        ],
      }),
    ).equal('in\nout');
    should(requestTexts({})).equal('');
    should([...requestToolNames({ tools: [{ name: 'Bash' }, { type: 'web_search' }, null] })]).deepEqual(['Bash']);
    should([...requestToolNames({})]).deepEqual([]);
  });
});

describe('spawning a CLI for real', () => {
  it('should report the exit code and the output, and a killed run as no exit code', async () => {
    // Act
    const finished = await bunCheckSpawn({
      cmd: ['/bin/sh', '-c', 'echo out; echo err >&2; exit 3'],
      cwd: tmpdir(),
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 10_000,
    });
    const killed = await bunCheckSpawn({ cmd: ['/bin/sleep', '5'], cwd: tmpdir(), env: {}, timeoutMs: 50 });

    // Assert
    should(finished.exitCode).equal(3);
    should(finished.output).equal('out\n\nerr\n');
    should(killed.exitCode).be.null();
  });

  it('should read a version banner, and nothing from a CLI that fails or cannot start', async () => {
    // Arrange
    const banner: CheckSpawn = async () => ({ exitCode: 0, output: '2.1.304 (Claude Code)\nmore\n' });
    const failing: CheckSpawn = async () => ({ exitCode: 1, output: '2.1.304' });
    const silent: CheckSpawn = async () => ({ exitCode: 0, output: '\n' });
    const throwing: CheckSpawn = async () => {
      throw new Error('ENOENT');
    };

    // Act
    const versions = await Promise.all(
      [banner, failing, silent, throwing].map(async spawn => await new CliHarnessVersion(spawn).version('/bin/cli')),
    );
    const real = await new CliHarnessVersion().version('/bin/echo');

    // Assert
    should(versions).deepEqual(['2.1.304 (Claude Code)', undefined, undefined, undefined]);
    // GNU echo prints its own banner and BSD echo prints the flag back; either way it is one line.
    should(real).be.a.String();
  });

  it('should run `--version` in a private, unguessable directory that is gone afterwards', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'fy-version-root-'));
    const seen: { cwd: string; home: string | undefined; mode: number }[] = [];
    const spawn: CheckSpawn = async request => {
      seen.push({ cwd: request.cwd, home: request.env.HOME, mode: (await stat(request.cwd)).mode & 0o777 });
      return { exitCode: 0, output: '2.1.304\n' };
    };

    try {
      // Act
      await new CliHarnessVersion(spawn, root).version('/bin/cli');
      await new CliHarnessVersion(spawn, root).version('/bin/cli');
      const left = await readdir(root);

      // Assert
      should(seen).have.length(2);
      for (const run of seen) {
        // A directory the shared temporary folder's other users could not have planted `.claude` in.
        should(run.cwd.startsWith(`${root}/`)).be.true();
        should(run.cwd).not.equal(root);
        should(run.home).equal(run.cwd);
        should(run.mode).equal(0o700);
      }
      should(seen[0]?.cwd).not.equal(seen[1]?.cwd);
      should(left).deepEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should still remove its private directory when the CLI cannot start', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'fy-version-root-'));
    const throwing: CheckSpawn = async () => {
      throw new Error('ENOENT');
    };

    try {
      // Act
      const actual = await new CliHarnessVersion(throwing, root).version('/bin/cli');

      // Assert
      should(actual).be.undefined();
      should(await readdir(root)).deepEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should read no version when no private directory can be made', async () => {
    // Arrange
    const spawn: CheckSpawn = async () => ({ exitCode: 0, output: '2.1.304\n' });

    // Act
    const actual = await new CliHarnessVersion(spawn, '/nonexistent/fy-no-such-root').version('/bin/cli');

    // Assert
    should(actual).be.undefined();
  });
});
