/**
 * What an agent runtime's Codex wrapper and materialised home rely on (design §8.3, §8.4, G8).
 *
 * Both claims here were INFERRED in the design and are pinned only by this file:
 *
 * - **Trust override.** The design's `-c projects."<cwd>".trust_level="trusted"` does NOT suppress
 *   the trust prompt on the pinned 0.145.0 — the quotes become part of the key. The spelling that
 *   works is a TOML inline table, `-c 'projects={"<cwd>"={trust_level="trusted"}}'`, and it MERGES
 *   with `config.toml`'s own `projects` table rather than replacing it. Each is read off the real
 *   first screen in a pseudo-terminal beside the control that shows the prompt.
 * - **Skills directory.** `<CODEX_HOME>/skills/<item>/SKILL.md` is listed as a user skill, including
 *   when `<item>` is a symlink into an asset tree, which is how the account model materialises it.
 */
import { afterAll, afterEach, beforeAll, describe, it } from 'bun:test';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { screenOf, startAppServer } from './support/fixtures.ts';
import { contract, harnessEnv, reap, requireHarness, type Sandbox, sandbox } from './support/harness.ts';
import { type RecordingProxy, startProxy } from './support/network.ts';

const TRUST = /Do you trust the contents of this directory/;
const COMPOSER = /OpenAI Codex \(v/;

/** The override U6's wrapper emits for the launch folder. */
const trustOverride = (cwd: string): string => `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`;

const skillDocument = (name: string): string =>
  `---\nname: ${name}\ndescription: Ferretry contract probe ${name}.\n---\nNothing to do.\n`;

describe.skipIf(!contract.enabled)('codex contract: launching an agent runtime', () => {
  let box: Sandbox;
  let proxy: RecordingProxy;
  let counter = 0;
  const codex = () => requireHarness('codex');

  beforeAll(async () => {
    box = await sandbox('codex-launch');
    proxy = startProxy();
  });
  afterEach(async () => {
    await reap(box.root);
  });
  afterAll(async () => {
    await reap(box.root);
    proxy.stop();
    await box.dispose();
  });

  /** A runtime home with a fresh fake login, and a working folder; `config` is appended to config.toml. */
  const runtime = async (config: (cwd: string) => string = () => '') => {
    counter++;
    const root = box.dir(`r${counter}`);
    const codexHome = path.join(root, 'codex');
    const work = path.join(root, 'work');
    const home = path.join(root, 'home');
    for (const directory of [codexHome, work, home]) await mkdir(directory, { recursive: true });
    const cwd = await realpath(work);
    // An API-key login: trust does not depend on how the runtime signs in, and from 0.16x a ChatGPT
    // login makes the TUI call the network while starting, so offline it exits before any prompt.
    await writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-FAKE-contract' }), {
      mode: 0o600,
    });
    await writeFile(path.join(codexHome, 'config.toml'), `cli_auth_credentials_store = "file"\n${config(cwd)}`);
    const env = harnessEnv(home, proxy.port, { CODEX_HOME: codexHome });
    const screen = (args: string[]) =>
      screenOf([codex().bin, '--no-alt-screen', ...args], { env, cwd, settled: [TRUST, COMPOSER] });
    return { root, codexHome, cwd, env, screen };
  };

  it('asks whether to trust an unknown folder (the control)', async () => {
    const screen = await (await runtime()).screen([]);
    should(screen).match(
      TRUST,
      'codex no longer asks whether to trust an unknown folder, so the override below measures nothing — find out what replaced the trust model before moving the pin',
    );
  });

  it('skips the trust prompt with the inline-table -c override for the launch folder', async () => {
    const r = await runtime();
    const screen = await r.screen(['-c', trustOverride(r.cwd)]);
    should(screen).match(COMPOSER);
    should(screen).not.match(TRUST);
  });

  it("merges the override with config.toml's projects: a folder the file trusts stays trusted", async () => {
    const r = await runtime(cwd => `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`);
    const elsewhere = path.join(r.root, 'some-other-folder');
    const screen = await r.screen(['-c', trustOverride(elsewhere)]);
    should(screen).match(COMPOSER);
    should(screen).not.match(TRUST);
  });

  it('lists skills under skills/<item>, including an item that is a symlink into an asset tree', async () => {
    const r = await runtime();
    await mkdir(path.join(r.codexHome, 'skills', 'fy-contract-real'), { recursive: true });
    await writeFile(
      path.join(r.codexHome, 'skills', 'fy-contract-real', 'SKILL.md'),
      skillDocument('fy-contract-real'),
    );
    const asset = path.join(r.root, 'assets', 'fy-contract-linked');
    await mkdir(asset, { recursive: true });
    await writeFile(path.join(asset, 'SKILL.md'), skillDocument('fy-contract-linked'));
    await symlink(asset, path.join(r.codexHome, 'skills', 'fy-contract-linked'));

    const server = await startAppServer(codex().bin, { env: r.env, cwd: r.cwd });
    try {
      const answer = (await server.request('skills/list', { cwds: [r.cwd], forceReload: true })) as {
        result?: { data?: { skills?: { name: string; scope: string }[] }[] };
      };
      const skills = (answer.result?.data ?? []).flatMap(entry => entry.skills ?? []);
      const user = skills.filter(skill => skill.scope === 'user').map(skill => skill.name);
      should(user).containEql('fy-contract-real').and.containEql('fy-contract-linked');
    } finally {
      await server.stop();
    }
  });
});
