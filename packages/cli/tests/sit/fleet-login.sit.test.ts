/**
 * `fy fleet login <accountId>`, through the real composition, on a real host.
 *
 * ## Why this tier and not a unit test
 *
 * The claim this command exists to keep is about a CHILD PROCESS: the account somebody names is the
 * account whose wrapper gets launched, because a harness writes its credential into the home of the
 * wrapper that ran. Every test above this tier replaces that child with a fake — the fleet unit suite
 * drives a recording port, and the integration suite drives the port with a stub binary — so all of
 * them prove the service ASKS for the right wrapper. None of them proves the assembled CLI launches
 * it.
 *
 * `packages/cli/bin/fy.ts` builds the login out of four collaborators (the identity service, the
 * platform credential store, the process login port and the token renewal), and `bin/**` is excluded
 * from BOTH coverage ledgers. So the wiring is typechecked and never executed. Swap the login port's
 * wrapper source for its binary lookup, or hand the port the wrong member, and every gate in the
 * repository stays green while the command signs in the wrong account on first use — which is
 * precisely the defect this branch fixes, and precisely the defect that shipped.
 *
 * A manual run proved it once. This is what makes it survive the next change.
 *
 * ## How it stays hermetic
 *
 * A temp `FY_HOME`, a fleet this test declares and materialises, and **stub wrappers of its own**
 * written over the generated ones. The stub records the argv it was given and — depending on the
 * journey — writes a credential into its own home or writes nothing at all. No harness is installed,
 * no network is touched, no live account is read, and nothing is launched that this file did not put
 * on disk.
 *
 * ## WHAT THIS DOES NOT PROVE
 *
 * The stub is not a harness. It proves which wrapper Ferretry launched and what Ferretry then reported
 * about each home — not that `claude auth login` behaves as assumed, which is a measurement recorded in
 * `docs/design/harness-login.md` and pinned by
 * `packages/fleet/tests/integration/process-login.test.ts`.
 */
import { afterEach, beforeAll, describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * Whether a credential written as a FILE is what this host's store reads back.
 *
 * On macOS Claude keeps its credential in a keychain item whose name is derived from the home path, so
 * a stub that writes `.credentials.json` there has written something the store will not find. The
 * journeys that read a credential back are therefore Linux-only and say so; the journeys about WHICH
 * WRAPPER RAN — the actual defect — hold on every platform, because they read the child's own record.
 * A stub that wrote to the keychain would be a test mutating the developer's keychain, which is not a
 * trade worth making for one assertion.
 */
const credentialsAreFiles = process.platform !== 'darwin';

const temporaryDirectories: string[] = [];
let driver: CliDriver;

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

interface Account {
  readonly id: string;
  readonly mode: string;
  readonly wrapper: string;
  readonly home: string;
}

interface Fleet {
  readonly environment: Record<string, string>;
  readonly stateHome: string;
  readonly interactive: Account;
  readonly auto: Account;
  /** Absolute path the stub wrappers append one line to per launch. */
  readonly launchLog: string;
}

/** Declare and materialise a two-lane claude identity — `claude-default` and `claude-auto-default`. */
async function fleet(): Promise<Fleet> {
  const stateHome = await mkdtemp(path.join(tmpdir(), 'fy-fleet-login-sit-'));
  temporaryDirectories.push(stateHome);
  const environment = { FY_HOME: stateHome, FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' };

  const initialized = await driver.run(['fleet', 'init', '--first-account=claude'], environment);
  should(initialized.code).equal(0, initialized.err);
  const applied = await driver.run(['fleet', 'apply'], environment);
  should(applied.code).equal(0, applied.err);

  const manifest = JSON.parse(await readFile(path.join(stateHome, 'fleet', 'manifest.json'), 'utf8')) as {
    accounts: readonly Account[];
  };
  const interactive = manifest.accounts.find(account => account.mode === 'interactive');
  const auto = manifest.accounts.find(account => account.mode === 'auto');
  should(interactive).be.ok();
  should(auto).be.ok();
  if (interactive === undefined || auto === undefined) throw new Error('the applied fleet has no two lanes');

  return { environment, stateHome, interactive, auto, launchLog: path.join(stateHome, 'launched.log') };
}

/**
 * Overwrite both generated wrappers with a stub.
 *
 * `writesCredential` is the difference between the two journeys below, and it is the difference
 * between a harness that completed a sign-in and one that exited zero having done nothing — which is
 * what a harness whose composed argv was refused actually looks like from here.
 */
async function stubWrappers(subject: Fleet, writesCredential: boolean): Promise<void> {
  const expiresAt = Date.now() + 86_400_000;
  for (const account of [subject.interactive, subject.auto]) {
    const credential = JSON.stringify({
      claudeAiOauth: {
        accessToken: `written-by-${path.basename(account.wrapper)}-TESTONLY`,
        refreshToken: 'refresh-TESTONLY',
        expiresAt,
      },
    });
    const write = writesCredential
      ? `printf '%s\\n' ${JSON.stringify(credential)} > ${JSON.stringify(path.join(account.home, '.credentials.json'))}\n`
      : '';
    await writeFile(
      account.wrapper,
      `#!/bin/sh\nprintf '%s %s\\n' ${JSON.stringify(path.basename(account.wrapper))} "$*" >> ${JSON.stringify(subject.launchLog)}\n${write}exit 0\n`,
    );
    await chmod(account.wrapper, 0o700);
  }
}

/** Every wrapper launch, in order. Absent when nothing was launched at all. */
async function launches(subject: Fleet): Promise<readonly string[]> {
  try {
    return (await readFile(subject.launchLog, 'utf8')).split('\n').filter(line => line.length > 0);
  } catch {
    return [];
  }
}

describe(`fleet login (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should launch the named account’s OWN wrapper and nobody else’s', async () => {
    // Arrange — no credential in either home, and a stub that completes a sign-in the way a harness
    // does: by writing into the home of the wrapper that ran.
    const subject = await fleet();
    await stubWrappers(subject, true);

    // Act — name the AUTO lane. Its identity has an interactive sibling, which is the member the
    // replaced `chooseLoginMember` returned for every caller.
    const login = await driver.run(['fleet', 'login', subject.auto.id, '--no-refresh'], subject.environment);

    // Assert — the command SUCCEEDS. An assembly error surfaces here as a non-zero exit with a
    // constructor or type failure in `err`, which is half the reason this test exists.
    should(login.code).equal(0, login.err);

    // THE DEFECT, IN ONE ASSERTION. Exactly one wrapper ran and it is the named account's own. On
    // `main` this line reads `claude-default` — the interactive sibling — so the harness wrote its
    // credential into a home nobody had asked about.
    const launched = await launches(subject);
    should(launched).have.length(1);
    should(launched[0]).startWith(path.basename(subject.auto.wrapper));
    should(launched[0]).not.startWith(path.basename(subject.interactive.wrapper));

    // And the account that was named is the one reported signed in, by its own id.
    should(login.out).containEql(`${subject.auto.id}  logged in`);
  });

  it('should say by name when the named account ends up with no credential of its own', async () => {
    // Arrange — the stub exits 0 and writes nothing, which is what a harness that refused the composed
    // argv looks like: no URL, no code, no credential, and a zero exit.
    const subject = await fleet();
    await stubWrappers(subject, false);

    // Act
    const login = await driver.run(['fleet', 'login', subject.auto.id, '--no-refresh'], subject.environment);

    // Assert — it still ran the right wrapper, and it refuses to call that a success.
    should(login.code).equal(0, login.err);
    should(await launches(subject)).have.length(1);
    should(login.out).containEql('FAILED');
    should(login.out).not.containEql('logged in');

    // The lane that RAN owns a sentence naming itself and the wrapper to go and run. The shared
    // identity-wide sentence names no account and suggests nothing, so it must not be this row's.
    const named = login.out.split('\n').find(line => line.includes(subject.auto.id));
    should(named).be.ok();
    should(named).containEql(subject.auto.id);
    should(named).containEql('left no credential in its own home');
    should(named).containEql(subject.auto.wrapper);

    // Its sibling, which nobody asked about, gets the identity-wide fact instead of being handed
    // somebody else's wrapper to run.
    const sibling = login.out.split('\n').find(line => line.includes(subject.interactive.id));
    should(sibling).containEql('this identity still has no usable credential');
    should(sibling).not.containEql(subject.auto.wrapper);
  });

  it.skipIf(!credentialsAreFiles)(
    'should leave the credential in the named account’s own home, read back through the real store',
    async () => {
      // Arrange
      const subject = await fleet();
      await stubWrappers(subject, true);

      // Act — sign in, then ask the command itself what each home now holds. `--status` reads through
      // the same platform credential store the login wrote through, so this is the store's answer and
      // not this test's opinion of the bytes.
      const login = await driver.run(['fleet', 'login', subject.auto.id, '--no-refresh'], subject.environment);
      should(login.code).equal(0, login.err);
      const status = await driver.run(['fleet', 'login', '--status', '--json'], subject.environment);
      should(status.code).equal(0, status.err);

      // Assert — the named account's own home holds a usable credential. A sibling's reading is never
      // evidence about this account, so it is read by id.
      const surveyed = JSON.parse(status.out) as readonly {
        readonly members: readonly {
          readonly member: { readonly accountId: string };
          readonly reading: { readonly state: string };
        }[];
      }[];
      const readings = new Map(
        surveyed.flatMap(identity => identity.members.map(entry => [entry.member.accountId, entry.reading.state])),
      );
      should(readings.get(subject.auto.id)).equal('valid');

      // And the sibling has it too, so the one approval is not spent again next time.
      should(readings.get(subject.interactive.id)).equal('valid');

      // The bytes came from the named account's own wrapper, not from the sibling's. This is the
      // difference between "a credential arrived" and "the right login produced it".
      const written = await readFile(path.join(subject.auto.home, '.credentials.json'), 'utf8');
      should(written).containEql(`written-by-${path.basename(subject.auto.wrapper)}-TESTONLY`);
    },
  );
});
