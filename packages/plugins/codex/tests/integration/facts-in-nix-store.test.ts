/**
 * The facts about a Codex that lives in the Nix store, asked of real small system programs (`uname`, `printenv`,
 * `readlink`). Only `realpath` and `nix` are stand-ins, scripts in a folder this test makes, because a real
 * `/nix/store` path and a real profile are the one thing a test must not depend on.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunSpawn } from '@ferretry/kernel/host';
import should from 'should';
import { HostCodexFacts } from '../../daemon/adapters/facts.ts';
import { HostPrograms } from '../../daemon/adapters/host-programs.ts';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const STORE = '/nix/store/abc123-codex-0.150.0';

async function machine(profile: string) {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-codex-facts-'));
  folders.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'realpath'), `#!/bin/sh\necho '${STORE}/bin/codex'\n`);
  await writeFile(join(bin, 'nix'), `#!/bin/sh\ncat <<'JSON'\n${profile}\nJSON\n`);
  await chmod(join(bin, 'realpath'), 0o755);
  await chmod(join(bin, 'nix'), 0o755);
  const launched = join(root, 'profile', 'bin', 'codex');
  await mkdir(join(root, 'profile', 'bin'), { recursive: true });
  await symlink(`${STORE}/bin/codex`, launched);
  const spawn = bunSpawn({ PATH: `${bin}:/usr/bin:/bin`, HOME: '/home/someone' });
  return { facts: new HostCodexFacts(new HostPrograms(spawn)), launched };
}

describe('HostCodexFacts for a file in the Nix store', () => {
  it('should name the profile element that holds it, the platform and the home it was asked from', async () => {
    const { facts, launched } = await machine(
      JSON.stringify({ version: 3, elements: { codex: { storePaths: [STORE] } } }),
    );

    const actual = await facts.facts(launched);

    should(actual.resolvedPath).equal(`${STORE}/bin/codex`);
    should(actual.launchedPath).equal(launched);
    should(actual.homeDirectory).equal('/home/someone');
    should(actual.nixProfileElement).equal('codex');
    should(actual.homeManagerProfile).equal(false);
    should(actual.viaHomeManagerPath).equal(false);
  });

  it('should say no profile element when the listing does not hold the file', async () => {
    const { facts, launched } = await machine(JSON.stringify({ version: 3, elements: {} }));

    const actual = await facts.facts(launched);

    should(actual.nixProfileElement).be.undefined();
  });
});
