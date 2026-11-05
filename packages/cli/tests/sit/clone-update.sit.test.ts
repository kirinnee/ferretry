/**
 * `fy machine clone` as a repeat copy, between two REAL daemons (docs/design/account-model.md §3.8, §7).
 *
 * Two daemons run in their own temp state homes on loopback; the CLI is driven against each with its own
 * address and host admin token, the way a person at either machine would. The source is exported with
 * `fy machine export`, then copied onto the target with `fy machine clone`, again and again:
 *
 * - the second copy has nothing to do: it says how many things are already the same, adds no slot and no
 *   `-2` name;
 * - after the source is edited, `--dry-run` lists exactly one "Changed on" line and writes nothing, and the
 *   update that follows changes only that item;
 * - owner decision §14.4: through an update, `--alongside`, `--replace` and `--forget`, the target's own
 *   signed-in login, the configuration of its API-key login that names a secret, and the secret store all
 *   stay exactly as they were. The sign-in is a file of sentinel tokens, compared to the byte; a secret
 *   VALUE has no route that returns it, so the store is compared by what it lists (name and update time)
 *   and the daemon-tier journeys compare the bytes themselves.
 *
 * Both daemons share this host's name, which a real pair never does and a copy refuses, so the export is
 * given the name of the other machine before it is copied.
 */
import { afterAll, afterEach, beforeAll, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAccountModel } from '@ferretry/fleet';
import { FleetCredentialListSchema, SecretListSchema } from '@ferretry/protocol';
import should from 'should';
import { writeModelFiles } from '../../../daemon/tests/integration/fleet/config-files-fixture.ts';
import {
  type BootedDaemon,
  bootDaemon,
  stopBootedDaemons,
} from '../../../daemon/tests/integration/support/booted-daemon.ts';
import { cleanupTempDirectories, tempDirectory } from '../../../daemon/tests/integration/support/repository.ts';
import pkg from '../../package.json' with { type: 'json' };
import { BinaryCliDriver, type CliDriver, type CliResult, InProcessCliDriver } from './driver';

const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

const SIGN_IN = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'SENTINEL-TARGET-ACCESS-TOKEN',
    refreshToken: 'SENTINEL-TARGET-REFRESH-TOKEN',
    expiresAt: 4_102_444_800_000,
  },
});
const SECRET_NAME = 'TARGET_API_KEY';
const SECRET_VALUE = 'sk-target-only-0123456789';
/** What the source is called on the target: the other machine's name, which a real pair does not share. */
const SOURCE_NAME = 'studio-mac';

/** The source: one sign-in login, one MCP server, a profile that layers it and a runtime on both. */
const sourceModel = () =>
  parseAccountModel({
    version: 2,
    credentials: { 'claude-work': { harness: 'claude', store: 'ferretry', label: 'Work' } },
    components: { mcp: { notes: { command: 'notes-server' } } },
    profiles: { review: { layers: ['mcp/notes'] } },
    runtimes: { 'claude-review': { credential: 'claude-work', profile: 'review' } },
  });

/** The target: its own signed-in login, an API-key login naming a secret, and a setup of its own. */
const targetModel = () =>
  parseAccountModel({
    version: 2,
    credentials: {
      'claude-you': { harness: 'claude', store: 'ferretry', label: 'You' },
      keyed: {
        harness: 'claude',
        store: 'environment',
        label: 'Keyed',
        preset: 'litellm',
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: `\${secret:${SECRET_NAME}}` },
      },
    },
    components: { mcp: { local: { command: 'local-server' } } },
    profiles: { default: { layers: ['mcp/local'] } },
    runtimes: { 'claude-you-default': { credential: 'claude-you', profile: 'default' } },
  });

let driver: CliDriver;
let source: BootedDaemon;
let target: BootedDaemon;

const against =
  (daemon: BootedDaemon) =>
  (args: string[]): Promise<CliResult> =>
    driver.run(args, {
      FY_URL: daemon.base,
      FY_TOKEN: (daemon.headers.authorization ?? '').replace(/^Bearer /u, ''),
      FY_SESSION_ID: '',
    });

/** Every file under `directory` with the hash of its bytes, by path relative to it. */
async function hashes(directory: string, relative = ''): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const entries = await readdir(join(directory, relative), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(found, await hashes(directory, next));
    else if (entry.isFile())
      found[next] = createHash('sha256')
        .update(await readFile(join(directory, next)))
        .digest('hex');
  }
  return found;
}

/** What the target's own login, its API-key login and its secret store look like, byte for byte where bytes can be read. */
async function protectedState(daemon: BootedDaemon) {
  const signIn = await hashes(join(daemon.home, 'fleet', 'credentials', 'claude-you'));
  const logins = await hashes(join(daemon.home, 'config', 'logins'));
  const secrets = SecretListSchema.parse(await (await daemon.get('/v1/secrets')).json());
  return {
    signIn,
    youLogin: logins['claude-you.yaml'],
    keyedLogin: logins['keyed.yaml'],
    secrets: secrets.secrets,
  };
}

const credentialIds = async (daemon: BootedDaemon): Promise<string[]> =>
  FleetCredentialListSchema.parse(await (await daemon.get('/v1/fleet/credentials')).json()).credentials.map(
    credential => credential.id,
  );

/** The source's export, given the other machine's name, written where the target's CLI can read it. */
async function exportedSetup(name: string): Promise<string> {
  const exported = await against(source)(['machine', 'export']);
  should(exported.code).equal(0);
  const path = join(await tempDirectory('ferretry-clone-sit-'), name);
  await writeFile(path, JSON.stringify({ ...JSON.parse(exported.out), machine: SOURCE_NAME }));
  return path;
}

beforeAll(async () => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
  [source, target] = await Promise.all([
    bootDaemon('source', {
      seed: async home => {
        await writeModelFiles(join(home, 'config'), sourceModel());
      },
    }),
    bootDaemon('target', {
      seed: async home => {
        await writeModelFiles(join(home, 'config'), targetModel());
        const login = join(home, 'fleet', 'credentials', 'claude-you');
        await mkdir(login, { recursive: true });
        await writeFile(join(login, '.credentials.json'), SIGN_IN, { mode: 0o600 });
      },
    }),
  ]);
  should((await target.post('/v1/secrets', { name: SECRET_NAME, value: SECRET_VALUE })).status).equal(200);
}, 120_000);

afterAll(async () => {
  await stopBootedDaemons();
});

afterEach(async () => {
  await cleanupTempDirectories();
});

describe(`fy machine clone, a repeat copy (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should copy once, find nothing to do the second time, show one change after an edit, and never touch a login', async () => {
    const onTarget = against(target);
    const before = await protectedState(target);
    should(Object.keys(before.signIn)).containEql('.credentials.json');
    should(before.keyedLogin).be.a.String();
    should(before.secrets.map(secret => secret.name)).deepEqual([SECRET_NAME]);

    // The first copy: nothing was copied from this machine before, so it adds the setup beside this one.
    const setup = await exportedSetup('setup.json');
    const first = await onTarget(['machine', 'clone', setup, '--yes']);
    should(first.code).equal(0);
    const loginsAfterFirst = await credentialIds(target);
    should(loginsAfterFirst).containEql('claude-work');
    should(await protectedState(target)).deepEqual(before);

    // The second copy of the same export: nothing differs, so nothing is added, no slot and no `-2`.
    const second = await onTarget(['machine', 'clone', setup]);
    should(second.code).equal(0);
    should(second.out).match(/^Update from studio-mac/mu);
    should(second.out).match(/\b\d+ things? already the same/u);
    should(second.out).containEql('Nothing to copy.');
    should(second.out).not.match(/^(New on|Changed on|Both changed)/mu);
    should(await credentialIds(target)).deepEqual(loginsAfterFirst);
    const named = Object.keys(await hashes(join(target.home, 'config')));
    should(named.filter(file => /-2(\.|\/|$)/u.test(file))).deepEqual([]);
    should(await protectedState(target)).deepEqual(before);

    // The source is edited; a dry run then lists exactly the one change and writes nothing.
    const edited = await against(source)([
      'component',
      'edit',
      'mcp/notes',
      '--command',
      'notes-server',
      '--arg',
      'v2',
      '--yes',
    ]);
    should(edited.code).equal(0);
    const changedSetup = await exportedSetup('changed.json');
    const configBefore = await hashes(join(target.home, 'config'));
    const dry = await onTarget(['machine', 'clone', changedSetup, '--dry-run']);
    should(dry.code).equal(0);
    should(dry.out.split('\n').filter(line => line.startsWith('Changed on'))).have.length(1);
    should(dry.out).containEql('mcp/notes');
    should(dry.out).not.match(/^(New on|Both changed)/mu);
    should(dry.out).containEql('Dry run: nothing was changed.');
    should(await hashes(join(target.home, 'config'))).deepEqual(configBefore);

    // The update takes that one change, and the login, its sign-in and the secret stay as they were.
    const updated = await onTarget(['machine', 'clone', changedSetup, '--yes']);
    should(updated.code).equal(0);
    const component = await onTarget(['component', 'show', 'mcp/notes', '--json']);
    should(component.out).containEql('v2');
    should(await credentialIds(target)).deepEqual(loginsAfterFirst);
    should(await protectedState(target)).deepEqual(before);

    // Add alongside, start over and forget: none of them reaches a login, a sign-in or a secret either.
    const alongside = await onTarget(['machine', 'clone', changedSetup, '--alongside', '--yes']);
    should(alongside.code).equal(0);
    should(await protectedState(target)).deepEqual(before);

    const replaced = await onTarget(['machine', 'clone', changedSetup, '--replace', '--yes']);
    should(replaced.code).equal(0);
    should(await protectedState(target)).deepEqual(before);

    const forgotten = await onTarget(['machine', 'clone', '--forget', SOURCE_NAME]);
    should(forgotten.code).equal(0);
    should(forgotten.out).containEql(`Forgot ${SOURCE_NAME}`);
    should(await protectedState(target)).deepEqual(before);

    // With the record gone the next copy from it starts over as a first copy, and says so.
    const afterForget = await onTarget(['machine', 'clone', changedSetup, '--forget', SOURCE_NAME]);
    should(afterForget.code).equal(1);
    should(afterForget.err).containEql('--forget stands alone');
    const nothingLeft = await onTarget(['machine', 'clone', '--forget', SOURCE_NAME]);
    should(nothingLeft.out).containEql(`There is no record of ${SOURCE_NAME}`);
    should(await protectedState(target)).deepEqual(before);
  }, 180_000);
});
