import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ferretsStep } from '../../src/steps/ferrets.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { textLooksLikeCredential } from '../../src/v4/config.ts';
import { fixture } from './ferret-fixture.ts';
import { advance, makeSandbox, type Sandbox } from './migrate-harness.ts';

setDefaultTimeout(60_000);

// G20 (C-114, D-05, D-104). Every value here is a FIXED FAKE.
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

describe('C-114: a variable NAME is never judged as a credential value', () => {
  test.each([
    'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}\n',
    'export ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY\n',
    'OPENAI_API_KEY: ${OPENAI_API_KEY}\n',
  ])('an environment reference %p carries', text => {
    expect(textLooksLikeCredential(text)).toBe(false);
  });

  test('a real value under the same name is still held', () => {
    expect(textLooksLikeCredential('ANTHROPIC_API_KEY=Zx9qLm2Pw8Rt5Vb7Nc4KabcdEfGh\n')).toBe(true);
  });

  test('a known key shape written as the NAME is still held', () => {
    expect(textLooksLikeCredential('sk-ant-FAKEFAKEFAKEFAKEFAKE0123=1\n')).toBe(true);
  });
});

describe('D-05: a held settings reason never prints a key-shaped env name', () => {
  const NAME = 'Zx9qLm2Pw8Rt5Vb7Nc4K';
  test('a ${secret:...} env and a non-text env, by key-shaped name, say <key>', async () => {
    const target = join(f.from, 'config/components/settings/odd.yaml');
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(
      target,
      `harness: claude\nenv:\n  ${NAME}: \${secret:SOME_NAME}\n  ${NAME}2Zz9: [1]\n  PLAIN_NAME: \${secret:OTHER}\n`,
      { mode: 0o600 },
    );
    const report = await settingsStep.run(f.ctx());
    const said = JSON.stringify(report);
    expect(said).not.toContain(NAME);
    expect(said).toContain('env <key> is a');
    expect(said).toContain('env PLAIN_NAME is a');
  });
});

describe('D-104: every attached ferret is carried as running', () => {
  test('a live pane with status awaiting_user is carried running, not idle', async () => {
    await f.session('idle1');
    await f.put('state/sessions/idle1/state.json', { id: 'idle1', turn: 0, status: 'awaiting_user' });
    await f.pane('idle1');
    await ferretsStep.run(f.ctx(false, async () => true));
    const state = JSON.parse(await readFile(join(f.to, 'state/ferrets/idle1/state.json'), 'utf8')) as {
      status: string;
    };
    expect(state.status).toBe('running');
  });
});

describe('migrate.sh', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await makeSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  test('D-29: a failing converter dry run stops backup with NOTHING moved', async () => {
    await advance(sb, 'quiet');
    await sb.state('dry.code', '3');
    const result = await sb.run('backup', ['--owner-yes']);
    expect(result.code).toBe(3);
    expect(result.err).toContain('NOTHING was moved');
    expect(await stat(join(sb.v4home, 'layout-version')).then(() => true)).toBe(true);
    expect(await sb.notesText()).not.toContain('# backing-up');
    expect(await sb.notesText()).not.toContain('# dry-run-ok');
  });

  test('D-29: the dry run reads the home BEFORE the move, and convert runs only the real run', async () => {
    await advance(sb, 'quiet');
    expect((await sb.run('backup', ['--owner-yes'])).code).toBe(0);
    expect((await sb.run('convert')).code).toBe(0);
    const calls = (await sb.calls()).filter(line => line.startsWith('bun src/main.ts'));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--dry-run');
    expect(calls[0]).toContain(`--from ${sb.v4home} `);
    expect(calls[1]).not.toContain('--dry-run');
  });

  test('D-24: quiet finds an unfinished history write (agenda-history.jsonl.pending)', async () => {
    await advance(sb, 'baseline');
    await writeFile(join(sb.v4home, 'state', 'sessions', 'f1', 'agenda-history.jsonl.pending'), '{}');
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('agenda-history.jsonl.pending');
  });

  test('D-24: a converter checkout moved off the recorded commit says to roll back and run preflight again', async () => {
    await advance(sb, 'backup');
    await writeFile(join(sb.repo, 'stray.txt'), 'x');
    for (const args of [
      ['add', '.'],
      ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-m', 'moved'],
    ])
      await Bun.spawn(['git', ...args], { cwd: sb.repo, stdout: 'ignore', stderr: 'ignore' }).exited;
    const result = await sb.run('convert');
    expect(result.err).toContain('run rollback --owner-yes, then preflight again');
  });
});
