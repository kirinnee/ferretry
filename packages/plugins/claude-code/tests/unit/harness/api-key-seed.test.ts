import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_KEY_SEED_NAME,
  API_KEY_SEED_SCRIPT,
  API_KEY_SEED_SHELL,
  seededCommand,
} from '../../../daemon/lib/harness/api-key-seed.ts';
import { launchCommand } from '../../../daemon/lib/harness/launch.ts';

/**
 * The seed is run FOR REAL here: a POSIX shell on a temp home with a fake key and a fake `claude` that records the
 * argv it was exec'd with. No tmux, no claude. Assertions compare by equality or count, so a failure never prints
 * the key or its tail.
 */
const FAKE_KEY = `sk-ant-fake-${'0'.repeat(28)}`;
const FAKE_TAIL = FAKE_KEY.slice(-20);

let fixture: string;
let home: string;
let record: string;
let claude: string;
let noTools: string;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'claude-api-key-seed-unit-'));
  home = join(fixture, 'agent-homes/f1');
  record = join(fixture, 'record.txt');
  claude = join(fixture, 'bin/claude');
  noTools = join(fixture, 'empty-path');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(fixture, 'bin'));
  await mkdir(noTools);
  // A fake claude: records its argv, and whether the seed's copy of the key leaked into its environment.
  await writeFile(
    claude,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$FAKE_RECORD"',
      'if [ -n "${FY_SEED_KEY+x}" ]; then echo leaked >> "$FAKE_RECORD"; fi',
      'exit 7',
      '',
    ].join('\n'),
  );
  await chmod(claude, 0o755);
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

const claudeJson = () => join(home, '.claude.json');

async function seed(options: { key?: string; path?: string } = {}) {
  const child = Bun.spawn([...seededCommand([claude, '--session-id', 'c-1'])], {
    env: {
      PATH: options.path ?? process.env.PATH ?? '/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: home,
      FAKE_RECORD: record,
      ...(options.key === undefined ? {} : { ANTHROPIC_API_KEY: options.key }),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const recorded = await readFile(record, 'utf8').catch(() => undefined);
  return { code, stdout, stderr, recorded };
}

const approved = async (): Promise<readonly unknown[]> => {
  const document = JSON.parse(await readFile(claudeJson(), 'utf8')) as {
    customApiKeyResponses?: { approved?: unknown[] };
  };
  return document.customApiKeyResponses?.approved ?? [];
};
const tailCount = async () => (await approved()).filter(entry => entry === FAKE_TAIL).length;
const execedClaude = (recorded: string | undefined) => expect(recorded).toBe('--session-id\nc-1\n');
const leftovers = async () => (await readdir(home)).filter(name => name !== '.claude.json');

describe('the launch argv', () => {
  test('runs claude through the fixed seed script, after env sets the home', () => {
    const argv = launchCommand({
      binary: '/opt/bin/claude',
      home: '/state/claude-code/agent-homes/f1',
      permissionMode: 'auto',
      hasMcp: false,
      conversation: { kind: 'new', id: 'c-1' },
    });
    expect(argv.slice(0, 7)).toEqual([
      'env',
      'CLAUDE_CONFIG_DIR=/state/claude-code/agent-homes/f1',
      API_KEY_SEED_SHELL,
      '-c',
      API_KEY_SEED_SCRIPT,
      API_KEY_SEED_NAME,
      '/opt/bin/claude',
    ]);
  });

  test('the seed script is a constant: nothing about a launch is interpolated into it', () => {
    const one = launchCommand({
      binary: '/a/claude',
      home: '/h/one',
      permissionMode: 'auto',
      hasMcp: false,
      conversation: { kind: 'new', id: 'c-1' },
    });
    const two = launchCommand({
      binary: '/b/claude',
      home: '/h/two',
      permissionMode: 'skip',
      hasMcp: true,
      model: 'claude-opus-5-5',
      conversation: { kind: 'resume', id: 'c-2' },
    });
    expect(one[4]).toBe(API_KEY_SEED_SCRIPT);
    expect(two[4]).toBe(API_KEY_SEED_SCRIPT);
    for (const word of ['/a/claude', '/b/claude', '/h/one', '/h/two', 'c-1', 'c-2', 'claude-opus-5-5'])
      expect(API_KEY_SEED_SCRIPT.includes(word)).toBe(false);
    // The value reaches jq through its environment, never as an argument a process listing would show.
    expect(API_KEY_SEED_SCRIPT.includes('--arg')).toBe(false);
    expect(API_KEY_SEED_SCRIPT.includes('$ENV.FY_SEED_KEY')).toBe(true);
  });
});

describe('the seed, run in a real shell', () => {
  test('appends the key tail once, and a second launch adds nothing', async () => {
    await writeFile(claudeJson(), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`);

    const first = await seed({ key: FAKE_KEY });
    expect(first.code).toBe(7);
    execedClaude(first.recorded);
    expect(await tailCount()).toBe(1);
    expect((await approved()).length).toBe(1);
    expect((await stat(claudeJson())).mode & 0o777).toBe(0o600);

    const before = await readFile(claudeJson(), 'utf8');
    const second = await seed({ key: FAKE_KEY });
    execedClaude(second.recorded);
    expect((await readFile(claudeJson(), 'utf8')) === before).toBe(true);
    expect(await tailCount()).toBe(1);
    expect(await leftovers()).toEqual([]);
  });

  test('keeps every other key and every earlier approval', async () => {
    await writeFile(
      claudeJson(),
      JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { '/work': { hasTrustDialogAccepted: true } },
        customApiKeyResponses: { approved: ['earlier-approval-00'], rejected: ['rejected-one'] },
      }),
    );

    execedClaude((await seed({ key: FAKE_KEY })).recorded);

    const document = JSON.parse(await readFile(claudeJson(), 'utf8')) as Record<string, unknown>;
    expect(document.hasCompletedOnboarding).toBe(true);
    expect(document.projects).toEqual({ '/work': { hasTrustDialogAccepted: true } });
    expect((document.customApiKeyResponses as { rejected: unknown }).rejected).toEqual(['rejected-one']);
    expect((await approved()).includes('earlier-approval-00')).toBe(true);
    expect(await tailCount()).toBe(1);
    expect((await approved()).length).toBe(2);
  });

  test('records at most the last 20 characters, and a short key whole', async () => {
    await writeFile(claudeJson(), '{}');
    await seed({ key: FAKE_KEY });
    expect((await approved()).every(entry => typeof entry === 'string' && entry.length <= 20)).toBe(true);
    expect((await approved()).includes(FAKE_KEY)).toBe(false);

    await writeFile(claudeJson(), '{}');
    await seed({ key: 'sk-fake-short' });
    expect(await approved()).toEqual(['sk-fake-short']);
  });

  test('a home with no document gets one holding only the approval', async () => {
    execedClaude((await seed({ key: FAKE_KEY })).recorded);
    expect(await tailCount()).toBe(1);
    expect(Object.keys(JSON.parse(await readFile(claudeJson(), 'utf8')) as object)).toEqual(['customApiKeyResponses']);
  });

  test("an unparseable document is left as it was, and claude is still exec'd", async () => {
    await writeFile(claudeJson(), '{ not json');

    const run = await seed({ key: FAKE_KEY });

    expect(run.code).toBe(7);
    execedClaude(run.recorded);
    expect(await readFile(claudeJson(), 'utf8')).toBe('{ not json');
    expect(await leftovers()).toEqual([]);
  });

  test('a document linked out of the home is neither followed nor replaced', async () => {
    const outside = join(fixture, 'outside.json');
    await writeFile(outside, '{"outside":true}');
    await symlink(outside, claudeJson());

    execedClaude((await seed({ key: FAKE_KEY })).recorded);

    expect(await readFile(outside, 'utf8')).toBe('{"outside":true}');
    expect(await leftovers()).toEqual([]);
  });

  test('no key in the environment changes nothing and still execs claude', async () => {
    await writeFile(claudeJson(), '{"hasCompletedOnboarding":true}');

    const run = await seed();

    execedClaude(run.recorded);
    expect(await readFile(claudeJson(), 'utf8')).toBe('{"hasCompletedOnboarding":true}');
    expect(run.stderr).toBe('');
    expect(await leftovers()).toEqual([]);
  });

  test('without jq it says so on stderr, writes nothing and still execs claude', async () => {
    await writeFile(claudeJson(), '{}');

    const run = await seed({ key: FAKE_KEY, path: noTools });

    execedClaude(run.recorded);
    expect(run.stderr).toContain('jq is not installed');
    expect(await readFile(claudeJson(), 'utf8')).toBe('{}');
  });

  test('the key never reaches stdout or stderr, and its copy is unset before claude starts', async () => {
    await writeFile(claudeJson(), '{}');

    for (const path of [undefined, noTools]) {
      const run = await seed({ key: FAKE_KEY, ...(path === undefined ? {} : { path }) });
      const shown = `${run.stdout}${run.stderr}${run.recorded ?? ''}`;
      expect(shown.includes(FAKE_TAIL)).toBe(false);
      expect(shown.includes('leaked')).toBe(false);
    }
  });
});
