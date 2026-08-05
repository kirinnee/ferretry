import { afterEach, beforeAll, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe(`fleet default assets (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should declare a script-selected first account without a YAML edit', async () => {
    const stateHome = await mkdtemp(path.join(tmpdir(), 'fy-fleet-first-account-sit-'));
    temporaryDirectories.push(stateHome);
    const environment = { FY_HOME: stateHome, FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' };

    // Act
    const initialized = await driver.run(['fleet', 'init', '--first-account=codex'], environment);

    // Assert — this is deliberately an init-only assertion: no wrapper is materialised until apply.
    should(initialized.code).equal(0, initialized.err);
    const config = Bun.YAML.parse(await readFile(path.join(stateHome, 'fleet', 'config.yaml'), 'utf8')) as {
      agents?: readonly { kind?: string; routes?: Record<string, { wrapper?: string }> }[];
    };
    should(config.agents).match([{ kind: 'codex', routes: { default: { wrapper: 'codex-primary' } } }]);
  });

  it('should add the first account after plain init left an empty configuration', async () => {
    const stateHome = await mkdtemp(path.join(tmpdir(), 'fy-fleet-empty-first-account-sit-'));
    temporaryDirectories.push(stateHome);
    const environment = { FY_HOME: stateHome, FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' };

    // Act — this is the exact recovery journey a person takes after their first init was empty.
    const plainInit = await driver.run(['fleet', 'init'], environment);
    const firstAccount = await driver.run(['fleet', 'init', '--first-account=codex'], environment);
    const applied = await driver.run(['fleet', 'apply'], environment);
    const listed = await driver.run(['fleet', 'ls'], environment);

    // Assert
    should(plainInit.code).equal(0, plainInit.err);
    should(firstAccount.code).equal(0, firstAccount.err);
    should(firstAccount.out).containEql('Declared one codex account');
    should(applied.code).equal(0, applied.err);
    should(listed.code).equal(0, listed.err);
    should(listed.out).containEql('1 account provisioned');
    const config = Bun.YAML.parse(await readFile(path.join(stateHome, 'fleet', 'config.yaml'), 'utf8')) as {
      agents?: readonly { kind?: string }[];
    };
    should(config.agents).match([{ kind: 'codex' }]);
  });

  it('should prefer Claude when the host can launch both harnesses', async () => {
    // The fake harnesses live OUTSIDE the state home, and that is a requirement rather than tidiness.
    // They are about `PATH`, not about Ferretry state, and a `bin/` of somebody else's executables
    // sitting in an unmarked `FY_HOME` is exactly what the layout claim refuses — correctly, since it
    // cannot tell that directory apart from a stranger's. Parking them inside used to work only
    // because nothing checked; `fy fleet init` now claims the home before it writes anything.
    const root = await mkdtemp(path.join(tmpdir(), 'fy-fleet-detected-account-sit-'));
    temporaryDirectories.push(root);
    const stateHome = path.join(root, 'state');
    const harnessBin = path.join(root, 'harness-bin');
    await mkdir(harnessBin);
    for (const harness of ['claude', 'codex']) {
      const executable = path.join(harnessBin, harness);
      await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(executable, 0o755);
    }
    const environment = { FY_HOME: stateHome, FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '', PATH: harnessBin };

    // Act — the optional flag asks the host for positive launch evidence; the shared policy owns the tie-break.
    const initialized = await driver.run(['fleet', 'init', '--first-account'], environment);

    // Assert
    should(initialized.code).equal(0, initialized.err);
    const config = Bun.YAML.parse(await readFile(path.join(stateHome, 'fleet', 'config.yaml'), 'utf8')) as {
      agents?: readonly { kind?: string }[];
    };
    should(config.agents).match([{ kind: 'claude' }]);
  });

  it('should carry every starter in the shipped command and never replace an existing one', async () => {
    const stateHome = await mkdtemp(path.join(tmpdir(), 'fy-fleet-assets-sit-'));
    temporaryDirectories.push(stateHome);
    const fleet = path.join(stateHome, 'fleet');
    const assets = path.join(fleet, 'assets');
    const environment = { FY_HOME: stateHome, FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' };

    // Act — CI runs this exact journey against the standalone `bun build --compile` artifact. That
    // is the boundary the predecessor missed when its init looked for a source-tree directory it never
    // shipped.
    const initialized = await driver.run(['fleet', 'init'], environment);

    // Assert
    should(initialized.code).equal(0, initialized.err);
    const expected = [
      path.join(fleet, 'config.yaml'),
      path.join(assets, 'README.md'),
      path.join(assets, 'CLAUDE.md'),
      path.join(assets, 'templates', 'claude', 'settings.json'),
      path.join(assets, 'templates', 'codex', 'config.toml'),
    ];
    for (const file of expected) should(await Bun.file(file).exists()).equal(true, file);

    const config = Bun.YAML.parse(await readFile(path.join(fleet, 'config.yaml'), 'utf8')) as {
      profiles?: {
        base?: {
          memory?: string;
          claude?: { settings?: string };
          codex?: { settings?: string };
        };
      };
    };
    should(config.profiles?.base).match({
      memory: './CLAUDE.md',
      claude: { settings: './templates/claude/settings.json' },
      codex: { settings: './templates/codex/config.toml' },
    });
    should(JSON.parse(await readFile(path.join(assets, 'templates', 'claude', 'settings.json'), 'utf8'))).match({
      includeCoAuthoredBy: false,
    });
    const codexSettings = await readFile(path.join(assets, 'templates', 'codex', 'config.toml'), 'utf8');
    should(codexSettings.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'))).deepEqual([]);

    // Arrange + Act — a pre-existing file has unknown origin. Whatever its origin, it wins and the
    // CLI says exactly that instead of silently restoring the bundled bytes.
    const instructions = path.join(assets, 'CLAUDE.md');
    const replacement = '# Existing instructions\n';
    await writeFile(instructions, replacement, 'utf8');
    const repeated = await driver.run(['fleet', 'init'], environment);

    // Assert
    should(repeated.code).equal(0, repeated.err);
    should(repeated.out).containEql(`${instructions} (pre-existing file wins; Ferretry did not replace it)`);
    should(await readFile(instructions, 'utf8')).equal(replacement);
  });
});
