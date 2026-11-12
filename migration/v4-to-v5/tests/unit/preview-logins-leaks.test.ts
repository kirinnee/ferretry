/**
 * The preview's login shells leak nothing: a shell is BUILT from an allowlist (never scrubbed), no login file is staged,
 * a failed prepare leaves no login bytes anywhere, a cloud-only login is held rather than written invalid, and an
 * environment login whose secret is not stored says "Needs sign-in" through the REAL logins status service.
 *
 * The first five tests are the review's five probes (`preview-logins-rv.probes.ts`) made real; the rest are the lead's
 * required scan. Every marker is synthetic; no real credential is read.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { link, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { LoginFileSchema } from '@ferretry/plugin-logins/contract';
import { decideStorelessStatus } from '../../../../packages/plugins/logins/daemon/lib/credentials/credential-status.ts';
import { resolveCredentialStore } from '../../../../packages/plugins/logins/daemon/lib/credentials/credentials.ts';
import { credentialIssues, credentialOf } from '../../../../packages/plugins/logins/daemon/lib/shared/credential.ts';
import { heldSection, prepare } from '../../preview/driver.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

/** Synthetic markers: each looks like what it stands for, and none is a real credential. */
const COMMENT_MARKER = 'sk-ant-FAKE-REVIEW-COMMENT-00000000';
const KEY_MARKER = 'sk-ant-FAKE-REVIEW-LITERAL-KEY-00000000';
const PATH_MARKER = '/tmp/review-fixture-google-credentials.json';
const WEBHOOK_TOKEN = 'T0KENabcdefghij1234567890WEBHOOK';

const home = () => join(f.root, 'home');
const target = () => join(home(), '.ferretry-v5');
const put = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true });
  await writeFile(join(f.from, path), text);
};
const run = (extra: { now?: () => Date } = {}) =>
  prepare({
    v4Home: f.from,
    target: target(),
    home: home(),
    lock: { held: async () => false },
    now: extra.now ?? (() => new Date('2026-11-09T00:00:00Z')),
  });

/** Every file's text under every `<HOME>/.ferretry-v5*` path (the home, its staging copy, proof, report, libexec). */
async function everythingPreview(): Promise<{ readonly roots: readonly string[]; readonly text: string }> {
  const roots = (await readdir(home()).catch(() => [] as string[])).filter(name => name.startsWith('.ferretry-v5'));
  const parts: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const facts = await stat(path).catch(() => undefined);
    if (facts === undefined) return;
    if (facts.isDirectory()) {
      parts.push(path);
      for (const entry of await readdir(path)) await visit(join(path, entry));
    } else if (facts.isFile()) parts.push(path, await readFile(path, 'utf8').catch(() => ''));
  };
  for (const root of roots) await visit(join(home(), root));
  return { roots, text: parts.join('\n') };
}

/** A v4 home with the three kinds of leak in its logins (the lead's required fixture) and a runtime on each. */
async function leakyHome() {
  await put('layout-version', '2\n');
  await put('config/profiles/main.yaml', 'contents: []\n');
  await put(
    'config/logins/work.yaml',
    [
      `# ${COMMENT_MARKER}`,
      'harness: claude # trailing comment',
      'store: environment',
      'env:',
      `  # ${COMMENT_MARKER}`,
      `  ANTHROPIC_API_KEY: ${KEY_MARKER}`,
      `  GOOGLE_APPLICATION_CREDENTIALS: ${PATH_MARKER}`,
      '  CLAUDE_CODE_USE_VERTEX: "1"',
      '  ANTHROPIC_BASE_URL: https://api.example.com/anthropic',
      `  WEBHOOK_URL: https://hooks.example.com/services/${WEBHOOK_TOKEN}`,
      '',
    ].join('\n'),
  );
  await put('config/runtimes/work.yaml', 'credential: work\nprofile: main\n');
}

describe('the review probes (all five were red on 931ce24222)', () => {
  test('no credential-shaped comment reaches a preview shell', async () => {
    await put('layout-version', '2\n');
    await put('config/logins/work.yaml', `# ${COMMENT_MARKER}\nharness: claude\nstore: host\n`);
    const done = await run();
    expect(done.report?.complete).toBe(true);
    expect(await readFile(join(target(), 'config/logins/work.yaml'), 'utf8')).not.toContain(COMMENT_MARKER);
  });

  test('no explicit credential file path reaches a preview shell', async () => {
    await put('layout-version', '2\n');
    await put(
      'config/logins/work.yaml',
      `harness: claude\nstore: environment\nenv:\n  GOOGLE_APPLICATION_CREDENTIALS: ${PATH_MARKER}\n  CLAUDE_CODE_USE_VERTEX: "1"\n`,
    );
    await run();
    const shell = await readFile(join(target(), 'config/logins/work.yaml'), 'utf8');
    expect(shell).not.toContain(PATH_MARKER);
    // The names stay, each pointing at a secret the owner stores: the shell is still a sign-in the owner can complete.
    expect(shell).toContain('GOOGLE_APPLICATION_CREDENTIALS: ${secret:LOGIN_WORK_GOOGLE_APPLICATION_CREDENTIALS}');
  });

  test('a cloud-only login is held by name, with its runtimes, instead of an invalid shell', async () => {
    await put('layout-version', '2\n');
    await put('config/profiles/main.yaml', 'contents: []\n');
    await put('config/logins/cloud.yaml', 'harness: claude\nstore: environment\ncloudCredential: aws-profile:work\n');
    await put('config/logins/ok.yaml', 'harness: claude\nstore: ferretry\n');
    await put('config/runtimes/cloud-rt.yaml', 'credential: cloud\nprofile: main\n');
    await put('config/runtimes/ok-rt.yaml', 'credential: ok\nprofile: main\n');
    const done = await run();
    expect(done.report?.complete).toBe(true);
    const logins = await readdir(join(target(), 'config/logins'));
    expect(logins).toEqual(['ok.yaml']);
    const held = heldSection(done.report as never);
    expect(held).toContain('login cloud (it has no way to sign in)');
    expect(held).toContain('runtime cloud-rt (its login is not carried)');
    expect(held).not.toContain('runtime ok-rt');
    // The one plain line says why.
    expect(held).toContain('no way to sign in');
    expect((await readdir(join(target(), 'config/runtimes'))).sort()).toEqual(['ok-rt.yaml']);
  });

  test('a carried environment shell is actually signed out, through the real status code', async () => {
    await put('layout-version', '2\n');
    await put(
      'config/logins/work.yaml',
      'harness: claude\nstore: environment\nenv:\n  ANTHROPIC_AUTH_TOKEN: ${secret:EMPTY_REVIEW_KEY}\n',
    );
    await run();
    const file = LoginFileSchema.parse(parse(await readFile(join(target(), 'config/logins/work.yaml'), 'utf8')));
    const resolution = resolveCredentialStore('work', credentialOf(file), undefined);
    // The vault is empty (it has no file in the preview): the name is not stored.
    expect(decideStorelessStatus(resolution, new Set()).word).toBe('needs_sign_in');
    // Once the owner stores it, the same login is Ready: the shell is completable, not stuck.
    expect(decideStorelessStatus(resolution, new Set(['EMPTY_REVIEW_KEY'])).word).toBe('ready');
  });

  test('a failed prepare leaves no staging copy, so no raw login key stays on disk', async () => {
    await put('layout-version', '2\n');
    await put(
      'config/logins/work.yaml',
      `harness: claude\nstore: environment\nenv:\n  ANTHROPIC_API_KEY: ${KEY_MARKER}\n`,
    );
    await put('config/profiles/main.yaml', 'contents: []\n');
    await link(join(f.from, 'config/profiles/main.yaml'), join(f.root, 'second-name.yaml'));
    await expect(run()).rejects.toThrow();
    const stagingLeft = await stat(`${target()}.staging`).then(
      () => true,
      () => false,
    );
    expect(stagingLeft).toBe(false);
  });
});

describe('no login byte survives a prepare, passing or failing', () => {
  const MARKERS = [COMMENT_MARKER, PATH_MARKER, KEY_MARKER, WEBHOOK_TOKEN];
  const expectNoMarker = async () => {
    const seen = await everythingPreview();
    for (const marker of MARKERS) expect(seen.text.includes(marker)).toBe(false);
    return seen;
  };

  test('a PASSING prepare: home, staging, proof, report and libexec hold none of the markers', async () => {
    await leakyHome();
    const done = await run();
    expect(done.report?.complete).toBe(true);
    const seen = await expectNoMarker();
    // The scan really saw the preview home and its report beside it.
    expect(seen.roots).toContain('.ferretry-v5');
    expect(seen.roots).toContain('.ferretry-v5.conversion-report.json');
    expect(seen.text).toContain('LOGIN_WORK_ANTHROPIC_API_KEY');
    expect(JSON.stringify(done.report)).not.toContain(KEY_MARKER);
    expect(done.summary).not.toContain(KEY_MARKER);
  });

  test('a prepare that THROWS at the stage (a hard-linked profile) leaves none of them', async () => {
    await leakyHome();
    await link(join(f.from, 'config/profiles/main.yaml'), join(f.root, 'second-name.yaml'));
    await expect(run()).rejects.toThrow();
    await expectNoMarker();
    expect(
      await stat(`${target()}.staging`).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test('a prepare that THROWS after the shells were written (the clock fails) leaves none of them', async () => {
    await leakyHome();
    let calls = 0;
    const now = () => {
      calls++;
      throw new Error('the clock failed');
    };
    await expect(run({ now })).rejects.toThrow();
    expect(calls).toBeGreaterThan(0);
    await expectNoMarker();
  });

  test('a webhook address with a token in its path becomes a reference; a plain provider address stays', async () => {
    await leakyHome();
    await run();
    const shell = await readFile(join(target(), 'config/logins/work.yaml'), 'utf8');
    expect(shell).not.toContain(WEBHOOK_TOKEN);
    expect(shell).toContain('WEBHOOK_URL: ${secret:LOGIN_WORK_WEBHOOK_URL}');
    expect(shell).toContain('ANTHROPIC_BASE_URL: https://api.example.com/anthropic');
    await expectNoMarker();
  });

  test('every carried shell is a valid login the status service can judge (no issue from the real rule)', async () => {
    await leakyHome();
    await put('config/logins/plain.yaml', 'harness: claude\nstore: host\nlabel: Me\n');
    await run();
    for (const name of await readdir(join(target(), 'config/logins'))) {
      const file = LoginFileSchema.parse(parse(await readFile(join(target(), 'config/logins', name), 'utf8')));
      expect(credentialIssues(credentialOf(file))).toEqual([]);
    }
  });
});
