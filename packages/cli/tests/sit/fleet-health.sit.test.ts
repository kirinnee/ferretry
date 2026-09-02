/**
 * `fy fleet health`, through the real composition, on a real host.
 *
 * ## Why this tier and not a unit test
 *
 * `packages/cli/bin/fy.ts` assembles the health collector out of four collaborators — the usage
 * collector, the Anthropic probe, the credential classifier and the platform credential store — and
 * `bin/**` is excluded from BOTH coverage ledgers. The controller's unit test drives a RECORDING FAKE,
 * so it proves the controller calls a collector and not that this collector is assembled correctly.
 * Nothing else executed that assembly.
 *
 * That is a real gap rather than a theoretical one: wire the usage collector to the wrong probe, or
 * pass the credential store where the classifier goes, and every gate in the repository stays green
 * while the command fails the first time somebody runs it. Reachability proves the symbols are
 * demanded from the composition root; it does not prove the wiring works.
 *
 * ## WHAT THIS DOES NOT PROVE — do not take it for the other gap
 *
 * It runs CREDENTIAL-FREE. The temp `FY_HOME` holds no credential, so `AnthropicUsageProbe` returns
 * `absent` and issues NO HTTP request at all — which is what keeps this hermetic and means it never
 * touches the network.
 *
 * So it closes exactly one hole: **the CLI's health composition is assembled correctly.** It does NOT
 * close the separate, declared gap that no test proves a CREDENTIALED account also spends nothing on a
 * scheduled tick from a booted daemon. That one is covered in part by
 * `packages/fleet/tests/integration/anthropic-usage-probe.test.ts` (the whole request list, on every
 * status including `403`) and is named in `docs/fleet-health.md`. Two different holes; a reader must
 * not read this test as closing that one.
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

describe(`fleet account health (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should report a real per-account verdict, and say it spent nothing', async () => {
    // Arrange — a fleet this test declares and materialises, so the verdict is about accounts it owns
    // rather than about whatever the developer running it happens to have.
    const stateHome = await mkdtemp(path.join(tmpdir(), 'fy-fleet-health-sit-'));
    temporaryDirectories.push(stateHome);
    const environment = { FY_HOME: stateHome, FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' };
    const initialized = await driver.run(['fleet', 'init', '--first-account=claude'], environment);
    should(initialized.code).equal(0, initialized.err);
    const applied = await driver.run(['fleet', 'apply'], environment);
    should(applied.code).equal(0, applied.err);

    // Act
    const health = await driver.run(['fleet', 'health'], environment);

    // Assert — the command SUCCEEDS. An assembly error surfaces here as a non-zero exit with a
    // constructor or type failure in `err`, which is the whole reason this test exists.
    should(health.code).equal(0, health.err);

    // A real verdict, reached from a local credential read: this home has none, so the honest answer
    // is that a login is needed. NOT `never_checked`, which is what a collector that ran nothing
    // would produce, and not `HEALTHY`, which is what one that fabricated a reading would.
    should(health.out).containEql('NEEDS LOGIN');
    should(health.out).containEql('no credential in this account home');
    should(health.out).containEql('2 accounts');

    // NO ESCAPE CODES ON A SURFACE THAT IS NOT A TERMINAL. Both drivers are one: the compiled binary
    // is spawned with `NO_COLOR=1` and piped, and the in-process driver captures into a string and
    // declares no width. Colour is the second channel here and the layout has to survive without it,
    // so the glyph and the aligned verdict column are asserted on the SAME plain output.
    should(health.out).not.containEql(`${String.fromCodePoint(0x1b)}[`);
    should(health.out).containEql('✗ ');
    // The whole account id, because `fy fleet login` matches on exactly it: a report that named the
    // account and nothing else would be readable and unactionable.
    should(health.out).match(/fy fleet login [0-9a-f-]{36}/u);

    // The disclosure, printed every time. The command this replaced launched every account's wrapper
    // and asked a model for a sentinel, so somebody who used it before has every reason to assume
    // this one still bills them.
    should(health.out).containEql('no inference quota');

    // NOTHING WAS LAUNCHED, stated as the absence of the words a sentinel turn would have produced.
    // The strong form of this claim — a real `fyd`, a recorder wrapper, and a scheduled tick — is
    // `packages/daemon/tests/integration/runtime/boot-lifecycle.test.ts`; this only checks that the
    // CLI path did not grow one back.
    should(health.out).not.containEql('FERRETRY_HEALTH_OK');
    should(health.err).not.containEql('FERRETRY_HEALTH_OK');
  });

  it('should not promise a sentinel turn in its own help', async () => {
    // Arrange — the report's disclosure and this command's one-line description disagreed. The
    // description still read "explicitly verify each wrapper can complete a sentinel turn", which is
    // what this command USED to do and what it exists to have stopped doing. `fy fleet --help` is
    // where somebody decides whether running it will cost them, so it is the one place the stale
    // sentence did the most damage — and no test read it.
    //
    // Asserted through the driver rather than off the source, because the string only reaches a person
    // via the composed command tree in `bin/fy.ts`, which is in NEITHER coverage ledger.

    // Act
    const help = await driver.run(['fleet', 'health', '--help'], { FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' });

    // Assert
    should(help.code).equal(0, help.err);
    should(help.out).not.containEql('sentinel turn');
    should(help.out).containEql('It spends nothing.');
    // And it says the row carries a copy-paste command, because the reported incident was somebody
    // reading a row that needed one action and finding no action on it.
    should(help.out).containEql('fy fleet login <accountId>');
  });
});
