/**
 * `fy fleet usage`, through the real composition, on a real host.
 *
 * ## Why this tier and not only a unit test
 *
 * The renderer's unit test proves the row prints whatever name it is handed, and the controller's
 * unit test proves the controller hands it the manifest's names. Neither proves that the manifest a
 * REAL host writes carries display names a person recognises — `packages/cli/bin/fy.ts` assembles the
 * manifest source, the config loader and the usage collector, and `bin/**` is excluded from BOTH
 * coverage ledgers. This defect was found by reading real output; it is caught again the same way.
 *
 * ## WHAT THIS DOES NOT PROVE
 *
 * It runs CREDENTIAL-FREE. The temp `FY_HOME` holds no credential, so the probe reports a failed
 * read and issues NO HTTP request at all — which is what keeps this hermetic and off the network. So
 * the quota FIGURES are never exercised here; the identity of the row is, and the identity is what
 * every branch of the renderer shares.
 */
import { afterEach, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { BinaryCliDriver, type CliDriver, InProcessCliDriver } from './driver';

const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

const temporaryDirectories: string[] = [];
let driver: CliDriver;

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe(`fleet quota reporting (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should name each account a person can recognise, never its provisioned id', async () => {
    // Arrange — a fleet this test declares and materialises, so the ids it checks for are ids this
    // host really minted rather than a fixture's stand-in.
    const stateHome = await mkdtemp(path.join(tmpdir(), 'fy-fleet-usage-sit-'));
    temporaryDirectories.push(stateHome);
    const environment = { FY_HOME: stateHome, FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' };
    const initialized = await driver.run(['fleet', 'init', '--first-account=claude'], environment);
    should(initialized.code).equal(0, initialized.err);
    const applied = await driver.run(['fleet', 'apply'], environment);
    should(applied.code).equal(0, applied.err);
    const manifest = (await Bun.file(path.join(stateHome, 'fleet', 'manifest.json')).json()) as {
      accounts: readonly { id: string; displayName: string }[];
    };

    // Act
    const usage = await driver.run(['fleet', 'usage'], environment);

    // Assert — the command SUCCEEDS. An assembly error surfaces here as a non-zero exit, which is the
    // other reason this test exists.
    should(usage.code).equal(0, usage.err);
    should(usage.out).containEql('2 accounts');

    // Every declared account is named, and NO row carries the opaque id it used to print.
    for (const account of manifest.accounts) {
      should(usage.out).containEql(account.displayName);
      should(usage.out).not.containEql(account.id);
    }

    // Nothing was spent and nothing was launched: with no credential in this home the probe never
    // opens a socket, so the honest row is a failed read rather than a fabricated zero.
    should(usage.out).containEql('probe failed');
  });
});
