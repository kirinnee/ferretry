import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deviceStanding,
  ferretStanding,
  FakeGate,
  ownerStanding,
  StandInAdmission,
} from '@ferretry/core-gate/contract/testing';
import type { CallStanding, SpawnOptions, SpawnResult } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { testHost } from '@ferretry/kernel/testing';
import { FakeSealedDocuments } from '@ferretry/core-vault/contract/testing';
import { GhRunAnswerSchema, GhRunRequestSchema, NO_SECRET_FIELDS } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { GhRunner } from '../../daemon/features/gh-run/gh-runner.ts';
import { FAKE_TOKEN, FakeGithub } from './fake-github.ts';

const CLIENT = 'Ov23FAKECLIENTID';
const ACCOUNT = 'gha_4242';
const OK: SpawnResult = { exitCode: 0, signal: null, stdout: '', stderr: '' };

type Call = { program: string; args: readonly string[]; options?: SpawnOptions };

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A project folder whose own `.git/config` runs a recorder as `core.fsmonitor`: it must never run. */
function projectFolder(): { root: string; recorder: string } {
  const root = mkdtempSync(join(tmpdir(), 'fy-gh-run-'));
  folders.push(root);
  const recorder = join(root, 'recorded');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'fsmonitor.sh'), `#!/bin/sh\necho ran > '${recorder}'\n`, { mode: 0o755 });
  writeFileSync(
    join(root, '.git', 'config'),
    `[core]\n\tfsmonitor = ${join(root, 'fsmonitor.sh')}\n[remote "origin"]\n\turl = https://evil.example/not/this\n`,
  );
  return { root, recorder };
}

async function boot(
  options: {
    projects?: readonly object[];
    ferretFolders?: Record<string, string>;
    standing?: () => CallStanding;
    spawn?: (call: Call) => SpawnResult | Promise<SpawnResult>;
  } = {},
) {
  const github = new FakeGithub();
  let connecting = true;
  github.tokenAnswers = [{ access_token: FAKE_TOKEN, scope: 'read:user repo' }];
  const sealed = new FakeSealedDocuments();
  const gate = new FakeGate();
  const calls: Call[] = [];
  const host = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => (connecting ? ownerStanding() : (options.standing ?? (() => ownerStanding()))())),
    fakes: { sealed, gate },
    uses: {
      projects: { list: async () => options.projects ?? [] },
      ferrets: { workFolder: async (ferret: string) => ({ folder: options.ferretFolders?.[ferret] as string }) },
    },
    fetch: github.fetch,
    spawn: (program: string, args: readonly string[], opts?: SpawnOptions) => {
      const call: Call = { program, args, ...(opts === undefined ? {} : { options: opts }) };
      calls.push(call);
      return options.spawn?.(call) ?? OK;
    },
    config: { 'git-accounts.yaml': { github: { clientId: CLIENT } } },
  });
  const responses: string[] = [];
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await host.request(method, path, body === undefined ? {} : { body });
    responses.push(response.body);
    return response;
  };
  const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
  await host.clock.advance(5000);
  await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`);
  connecting = false;
  responses.length = 0;
  calls.length = 0;
  gate.audits.length = 0;
  const gh = async (argv: string[], cwd: string, extra: Record<string, unknown> = {}) =>
    await request('POST', '/v1/git-accounts/gh/run', { argv, cwd, ...extra });
  return { host, gate, calls, responses, request, gh };
}

const linked = (path: string, extra: object = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'app',
  path,
  source: 'existing-folder',
  createdAt: '2026-11-19T00:00:00.000Z',
  accounts: [ACCOUNT],
  repos: [{ path: '.', remote: 'https://github.com/acme/app', provider: 'github' }],
  ...extra,
});

const everything = (world: Awaited<ReturnType<typeof boot>>) =>
  [
    ...world.responses,
    ...world.host.logs.map(log => `${log.message} ${JSON.stringify(log.fields ?? {})}`),
    JSON.stringify(world.gate.audits),
  ].join('\n');

describe("Ferretry's gh runs as the account the folder is linked to", () => {
  test('a person in a linked folder: the repository comes from the project record, the token is only in the child', async () => {
    const { root, recorder } = projectFolder();
    const world = await boot({
      projects: [linked(root)],
      spawn: () => ({ exitCode: 0, signal: null, stdout: `list ${FAKE_TOKEN}`, stderr: '' }),
    });
    const answer = await world.gh(['pr', 'list', '--state', 'open'], root);
    expect(answer.status).toBe(200);
    expect(answer.json()).toEqual({ exitCode: 0, stdout: 'list [redacted]', stderr: '' });
    expect(world.calls).toHaveLength(1);
    const call = world.calls[0] as Call;
    expect(call.program).toBe('gh');
    // The repository is the record's (github.com/acme/app), NOT the evil remote in the folder's own .git/config.
    expect(call.args).toEqual(['pr', 'list', '-R', 'acme/app', '--state', 'open']);
    const env = call.options?.env as Record<string, string>;
    expect(env.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(call.options?.sealed).toBe(true);
    // Ferretry's own empty folder: never the agent's folder, so its .git/config and hooks cannot run.
    expect(call.options?.cwd).not.toStartWith(root);
    expect(env.HOME).toStartWith(call.options?.cwd as string);
    expect(env.GH_CONFIG_DIR).toStartWith(call.options?.cwd as string);
    expect(await Bun.file(recorder).exists()).toBe(false);
    expect(call.args.join(' ')).not.toContain(FAKE_TOKEN);
    expect(everything(world)).not.toContain(FAKE_TOKEN);
  });

  test('the audit names the account, the command, the repository and the exit code: no other argument', async () => {
    const { root } = projectFolder();
    const world = await boot({ projects: [linked(root)] });
    await world.gh(['pr', 'list', '--search', 'a private query'], root);
    expect(world.gate.audits).toHaveLength(1);
    const record = world.gate.audits[0] as { subject?: string; outcome: string; detail?: Record<string, unknown> };
    expect(record.subject).toBe(ACCOUNT);
    expect(record.outcome).toBe('succeeded');
    expect(record.detail).toEqual({ command: 'pr list', repo: 'acme/app', exitCode: 0 });
    expect(JSON.stringify(world.gate.audits)).not.toContain('private query');
  });

  test('a repository the caller names with -R is kept; the api endpoint placeholders come from the record', async () => {
    const { root } = projectFolder();
    const world = await boot({ projects: [linked(root)] });
    await world.gh(['pr', 'list', '-R', 'other/thing'], root);
    await world.gh(['api', 'repos/{owner}/{repo}/pulls'], root);
    expect(world.calls[0]?.args).toEqual(['pr', 'list', '-R', 'other/thing']);
    expect(world.calls[1]?.args).toEqual(['api', 'repos/acme/app/pulls']);
  });

  test('a project that records no repository for the folder: a sentence, until -R is given', async () => {
    const { root } = projectFolder();
    const world = await boot({ projects: [linked(root, { repos: [] })] });
    const refused = (await world.gh(['pr', 'list'], root)).json<{ refused: string }>();
    expect(refused.refused).toContain('-R OWNER/NAME');
    expect(world.calls).toHaveLength(0);
    await world.gh(['pr', 'list', '-R', 'a/b'], root);
    expect(world.calls).toHaveLength(1);
  });

  test('a remote that is not a github.com repository is not used', async () => {
    const { root } = projectFolder();
    const world = await boot({
      projects: [linked(root, { repos: [{ path: '.', remote: 'https://evil.example/o/r' }] })],
    });
    expect((await world.gh(['pr', 'list'], root)).json()).toHaveProperty('refused');
    expect(world.calls).toHaveLength(0);
  });

  test('outside a linked project: refused with what to do, and no child is started (the host gh is never a fallback)', async () => {
    const { root } = projectFolder();
    const world = await boot({ projects: [linked(root, { accounts: [] })] });
    const refused = (await world.gh(['pr', 'list'], root)).json<{ refused: string }>();
    expect(refused.refused).toContain('no project linked to a GitHub account');
    const elsewhere = (await world.gh(['pr', 'list'], '/somewhere/else')).json<{ refused: string }>();
    expect(elsewhere.refused).toContain('Link one on the project page');
    expect(world.calls).toHaveLength(0);
  });

  test('auth status is answered from the account record; gh is not run', async () => {
    const { root } = projectFolder();
    const world = await boot({ projects: [linked(root)] });
    const answer = (await world.gh(['auth', 'status'], root)).json<{ exitCode: number; stdout: string }>();
    expect(answer.exitCode).toBe(0);
    expect(answer.stdout).toContain('Logged in to github.com as octo-fake (Ferretry)');
    expect(world.calls).toHaveLength(0);
    expect(everything(world)).not.toContain(FAKE_TOKEN);
  });
});

describe('what is refused is answered with a sentence, audited as refused, and never started', () => {
  test.each([
    [['auth', 'token'], 'never shows its token'],
    [['auth', 'status', '--show-token'], 'never shows its token'],
    [['config', 'get', 'oauth_token'], 'no config'],
    [['extension', 'install', 'o/gh-x'], 'not available'],
    [['pr', 'checkout', '3'], 'Use git'],
    [['pr', 'list', '--hostname', 'evil.example'], 'github.com only'],
    [['frobnicate'], "is not a command Ferretry's gh runs"],
  ])('%j', async (argv, expected) => {
    const { root } = projectFolder();
    const world = await boot({ projects: [linked(root)] });
    const refused = (await world.gh(argv, root)).json<{ refused: string }>();
    expect(refused.refused).toContain(expected);
    expect(world.calls).toHaveLength(0);
    expect((world.gate.audits[0] as { outcome: string }).outcome).toBe('refused');
    expect(everything(world)).not.toContain(FAKE_TOKEN);
  });

  test('GAP made visible: what the plan wanted but the B1 seam still refuses is passed on as its sentence, nothing is run', async () => {
    const { root } = projectFolder();
    const world = await boot({ projects: [linked(root)] });
    for (const argv of [
      ['repo', 'create', 'new-thing'],
      ['secret', 'list'],
      ['pr', 'ready', '3'],
    ]) {
      const refused = (await world.gh(argv, root)).json<{ refused: string }>();
      expect(refused.refused).toContain('gh is not run that way');
    }
    expect(world.calls).toHaveLength(0);
  });
});

describe('who may ask, and for which folder', () => {
  const { root } = projectFolder();

  test("a ferret works in its own folder (and below); a neighbouring project's folder is refused", async () => {
    const mine = mkdtempSync(join(tmpdir(), 'fy-gh-mine-'));
    const theirs = mkdtempSync(join(tmpdir(), 'fy-gh-theirs-'));
    folders.push(mine, theirs);
    const world = await boot({
      projects: [linked(mine), linked(theirs, { id: '00000000-0000-4000-8000-000000000002' })],
      ferretFolders: { f1: mine },
      standing: () => ferretStanding('f1' as never),
    });
    expect((await world.gh(['pr', 'list'], mine)).json()).not.toHaveProperty('refused');
    expect((await world.gh(['pr', 'list'], `${mine}/packages/x`)).json()).not.toHaveProperty('refused');
    expect(world.calls).toHaveLength(2);
    const other = (await world.gh(['pr', 'list'], theirs)).json<{ refused: string }>();
    expect(other.refused).toContain('folder this ferret works in');
    const sibling = (await world.gh(['pr', 'list'], `${mine}-two`)).json<{ refused: string }>();
    expect(sibling.refused).toContain('folder this ferret works in');
    const dotdot = (await world.gh(['pr', 'list'], `${mine}/../${theirs.split('/').pop()}`)).json<{
      refused: string;
    }>();
    expect(dotdot.refused).toContain('plain absolute path');
    expect(world.calls).toHaveLength(2);
    expect(JSON.stringify(world.gate.audits)).toContain('"ferret":"f1"');
  });

  test('a ferret may not choose an account; the owner may, by login', async () => {
    const { root: folder } = projectFolder();
    const asFerret = await boot({
      projects: [linked(folder, { accounts: [] })],
      ferretFolders: { f1: folder },
      standing: () => ferretStanding('f1' as never),
    });
    const refused = (await asFerret.gh(['pr', 'list', '-R', 'a/b'], folder, { account: 'octo-fake' })).json<{
      refused: string;
    }>();
    expect(refused.refused).toContain('does not choose the account');
    expect(asFerret.calls).toHaveLength(0);

    const asOwner = await boot({ projects: [linked(folder, { accounts: [] })] });
    expect((await asOwner.gh(['pr', 'list', '-R', 'a/b'], folder, { account: 'OCTO-FAKE' })).json()).not.toHaveProperty(
      'refused',
    );
    expect(asOwner.calls).toHaveLength(1);
    const unknown = (await asOwner.gh(['pr', 'list', '-R', 'a/b'], folder, { account: 'nobody' })).json<{
      refused: string;
    }>();
    expect(unknown.refused).toContain('No connected GitHub account');
  });

  test('a ferret whose folder cannot be placed is refused', async () => {
    const world = await boot({
      projects: [linked(root)],
      ferretFolders: {},
      standing: () => ferretStanding('f9' as never),
    });
    expect((await world.gh(['pr', 'list'], root)).json()).toHaveProperty('refused');
    expect(world.calls).toHaveLength(0);
  });

  test('a paired device needs secrets.use', async () => {
    const denied = deviceStanding('phone', {
      fleet: { use: true, configure: true },
      secrets: { use: false, configure: false },
    } as never);
    const world = await boot({ projects: [linked(root)], standing: () => denied });
    expect((await world.gh(['pr', 'list'], root)).status).toBe(403);
    expect(world.calls).toHaveLength(0);
    const allowed = deviceStanding('phone', {
      fleet: { use: true, configure: true },
      secrets: { use: true, configure: false },
    } as never);
    const ok = await boot({ projects: [linked(root)], standing: () => allowed });
    expect((await ok.gh(['pr', 'list'], root)).status).toBe(200);
    expect(ok.calls).toHaveLength(1);
  });

  test('a malformed request is a 400 that names no value', async () => {
    const world = await boot({ projects: [linked(root)] });
    for (const body of [
      { argv: [], cwd: root },
      { argv: ['pr'], cwd: 'relative' },
      { argv: ['pr'], cwd: root, stdin: 'x' },
    ]) {
      const response = await world.request('POST', '/v1/git-accounts/gh/run', body);
      expect(response.status).toBe(400);
    }
    expect(world.calls).toHaveLength(0);
  });
});

describe('bounds', () => {
  test('at most 4 runs at once for one caller; the 5th is refused until one finishes', async () => {
    const release: (() => void)[] = [];
    const runner = new GhRunner({
      accounts: {
        list: async () =>
          [
            {
              id: ACCOUNT,
              provider: 'github',
              githubId: 1,
              login: 'octo',
              scopes: [],
              keys: {},
              createdAt: '2026-11-19T00:00:00.000Z',
            },
          ] as never,
        run: () => new Promise(resolve => release.push(() => resolve({ exitCode: 0, stdout: '', stderr: '' }))),
      },
      projects: async () => [linked('/w')] as never,
      workFolder: async () => undefined,
      audit: async () => undefined,
    });
    const ask = () => runner.run({ actor: { kind: 'host' } }, { argv: ['pr', 'list'], cwd: '/w' });
    const pending = [1, 2, 3, 4].map(ask);
    while (release.length < 4) await Bun.sleep(1);
    expect(await ask()).toMatchObject({ refused: expect.stringContaining('already running 4') });
    for (const done of release) done();
    await Promise.all(pending);
    const again = ask();
    while (release.length < 5) await Bun.sleep(1);
    release[4]?.();
    expect(await again).toMatchObject({ exitCode: 0 });
  });

  test('a followed run gets the long clock, an ordinary one the short', async () => {
    const { root } = projectFolder();
    const world = await boot({ projects: [linked(root)] });
    await world.gh(['pr', 'list'], root);
    await world.gh(['run', 'watch', '9'], root);
    expect(world.calls.map(call => call.options?.timeout)).toEqual([milliseconds(120_000), milliseconds(300_000)]);
  });
});

describe('wire shapes', () => {
  test('no field of the request or the answer could hold a token, and both are strict', () => {
    for (const schema of [GhRunRequestSchema, GhRunAnswerSchema]) {
      const text = JSON.stringify(schema.toJSONSchema());
      for (const key of text.match(/"[A-Za-z]+":/gu) ?? []) {
        const name = key.replaceAll(/["':]/gu, '');
        if (
          [
            'type',
            'properties',
            'required',
            'items',
            'anyOf',
            'maxLength',
            'minLength',
            'maxItems',
            'minItems',
            'additionalProperties',
            'format',
            'pattern',
            'description',
          ].includes(name)
        )
          continue;
        expect(NO_SECRET_FIELDS.test(name)).toBe(false);
      }
    }
    expect(GhRunRequestSchema.safeParse({ argv: ['pr'], cwd: '/x', stdin: 'x' }).success).toBe(false);
    expect(GhRunAnswerSchema.safeParse({ exitCode: 0, stdout: '', stderr: '', extra: 1 }).success).toBe(false);
  });
});
