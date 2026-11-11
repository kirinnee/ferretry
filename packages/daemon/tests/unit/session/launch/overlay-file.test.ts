/**
 * A launch overlay that carries the login's environment never rides the argv.
 *
 * The claims: such an overlay is written to a per-launch file and the argv names only its PATH; a credential
 * therefore appears in neither the argv nor the command a session document records; the path is a pure function
 * of the launch, so a revive rebuilds the file a running process was started with; and the stale-settings read
 * sees through the path the way it saw through the inline overlay.
 *
 * NO REAL CREDENTIAL APPEARS HERE: SYNTHETIC is a fixture string, and the assertions are about where it goes.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  adoptedLaunchArgv,
  buildLaunchArgv,
  defaultStartWaitPolicy,
  FixedSettingsUnreadableError,
  type LaunchOverlayFile,
  type LaunchOverlayFiles,
  LaunchOverlayFileRequiredError,
  launchedCompactAt,
  launchOverlayFile,
  type LaunchSubject,
  parseSessionId,
  prepareLaunchArgv,
  type RecordedLaunch,
  type SessionLaunchPorts,
  SessionLaunchService,
  SessionPlanner,
  settingsArguments,
} from '../../../../src/lib/index.ts';
import { launchAccount, launchConfig, launchState } from './support.ts';

const SYNTHETIC = 'synthetic-credential-0000';
const WRAPPER = '/fleet/bin/claude-auto-boot';
const DIRECTORY = '/state/launch-settings';
const FIXED = JSON.stringify({
  skipAutoPermissionPrompt: true,
  env: { ANTHROPIC_BASE_URL: 'https://provider.example/anthropic', ANTHROPIC_AUTH_TOKEN: SYNTHETIC },
});
const PLAIN = JSON.stringify({ skipAutoPermissionPrompt: true });

const parts = (extra: Record<string, unknown> = {}) => ({
  harness: 'claude' as const,
  executable: WRAPPER,
  remoteControl: [],
  transcript: [],
  readableFolders: [],
  model: 'claude-opus-5',
  harnessFlags: [],
  ...extra,
});

/** A port that records what it is asked and places files under {@link DIRECTORY}. */
class Files implements LaunchOverlayFiles {
  readonly asked: { file: LaunchOverlayFile; write: boolean }[] = [];
  async place(file: LaunchOverlayFile, options: { readonly write: boolean }): Promise<string> {
    this.asked.push({ file, write: options.write });
    return `${DIRECTORY}/${file.name}`;
  }
}

describe('launchOverlayFile', () => {
  it('should name no file for a launch that needs none', () => {
    should(launchOverlayFile('claude', { fast: true }, PLAIN)).be.undefined();
    should(launchOverlayFile('claude', { fast: true }, '')).be.undefined();
    should(launchOverlayFile('claude', { fast: true }, '{"env":{}}')).be.undefined();
    should(launchOverlayFile('claude', {}, FIXED)).be.undefined();
    should(launchOverlayFile('codex', { fast: true }, FIXED)).be.undefined();
  });

  it('should write the merged overlay, named by the login’s settings, the trigger and fast mode', () => {
    // Act
    const file = launchOverlayFile('claude', { fast: true, compactAt: 250_000 }, FIXED);

    // Assert
    should(file?.name).match(/^launch-[0-9a-f]{24}-c250000-f1\.json$/u);
    should(JSON.parse(file?.content ?? '{}')).eql({
      ...JSON.parse(FIXED),
      fastMode: true,
      autoCompactWindow: 250_000,
    });
  });

  it('should name the same file for the same launch and another for another login or setting', () => {
    const fast = launchOverlayFile('claude', { fast: true }, FIXED);
    should(launchOverlayFile('claude', { fast: true }, FIXED)?.name).equal(fast?.name);
    should(launchOverlayFile('claude', { fast: false }, FIXED)?.name).not.equal(fast?.name);
    should(launchOverlayFile('claude', { fast: true }, FIXED.replace(SYNTHETIC, 'other'))?.name).not.equal(fast?.name);
  });

  it('should refuse a fixed settings text that is not an object, as an inline overlay does', () => {
    should(() => launchOverlayFile('claude', { fast: true }, '[1]')).throw(FixedSettingsUnreadableError);
  });
});

describe('buildLaunchArgv with an overlay that carries an environment', () => {
  it('should refuse to inline it, whatever is asked, rather than put a credential on the argv', () => {
    for (const wanted of [{ fast: true }, { fast: false }, { compactAt: 200_000 }, { fast: true, compactAt: 1 }]) {
      should(() => buildLaunchArgv(parts({ ...wanted, fixedSettings: FIXED }))).throw(LaunchOverlayFileRequiredError);
    }
  });

  it('should name only the file’s path', () => {
    // Act
    const argv = buildLaunchArgv(
      parts({ fast: true, fixedSettings: FIXED, overlayFile: `${DIRECTORY}/launch-x.json` }),
    );

    // Assert
    should(argv.slice(-2)).eql(['--settings', `${DIRECTORY}/launch-x.json`]);
    should(argv.join(' ')).not.containEql(SYNTHETIC);
  });

  it('should still inline an overlay that carries no environment, as before', () => {
    // Act
    const argv = buildLaunchArgv(parts({ fast: true, fixedSettings: PLAIN }));

    // Assert
    should(JSON.parse(argv.at(-1) as string)).eql({ skipAutoPermissionPrompt: true, fastMode: true });
  });
});

describe('prepareLaunchArgv', () => {
  it('should write the file first and leave the credential out of the argv', async () => {
    // Arrange
    const files = new Files();

    // Act
    const argv = await prepareLaunchArgv(parts({ fast: false, compactAt: 90_000, fixedSettings: FIXED }), files);

    // Assert
    should(files.asked).have.length(1);
    should(files.asked[0]?.write).be.true();
    should(files.asked[0]?.file.content).containEql(SYNTHETIC);
    should(argv.join('\u0000')).not.containEql(SYNTHETIC);
    should(argv.at(-2)).equal('--settings');
    should(argv.at(-1)).equal(`${DIRECTORY}/${files.asked[0]?.file.name}`);
  });

  it('should only ask where the file would be when it is asked not to write', async () => {
    // Arrange
    const files = new Files();

    // Act
    await prepareLaunchArgv(parts({ fast: true, fixedSettings: FIXED }), files, { write: false });

    // Assert
    should(files.asked[0]?.write).be.false();
  });

  it('should use no port at all for a launch that needs no file', async () => {
    // Arrange
    const files = new Files();

    // Act
    const argv = await prepareLaunchArgv(parts({ fast: true, fixedSettings: PLAIN }), files);

    // Assert
    should(files.asked).be.empty();
    should(argv.at(-2)).equal('--settings');
  });

  it('should refuse a launch that needs a file when there is no port, or the file cannot be placed', async () => {
    // Act / Assert
    await should(prepareLaunchArgv(parts({ fast: true, fixedSettings: FIXED }), undefined)).rejectedWith(
      LaunchOverlayFileRequiredError,
    );
    await should(
      prepareLaunchArgv(parts({ fast: true, fixedSettings: FIXED }), {
        place: async () => {
          throw new Error('disk full');
        },
      }),
    ).rejectedWith(FixedSettingsUnreadableError);
    await should(
      prepareLaunchArgv(parts({ fast: true, fixedSettings: FIXED }), { place: async () => undefined }),
    ).rejectedWith(FixedSettingsUnreadableError);
  });
});

describe('the stale-settings read of a per-launch overlay file', () => {
  const argvFor = async (wanted: Record<string, unknown>, fixed = FIXED) =>
    await prepareLaunchArgv(parts({ ...wanted, fixedSettings: fixed }), new Files());

  it('should treat fast mode as a run fact: a different fast state is not a stale setting', async () => {
    should(settingsArguments(await argvFor({ fast: true }))).eql(settingsArguments(await argvFor({ fast: false })));
  });

  it('should keep the compaction trigger visible, as a marker, and read it back from the command', async () => {
    // Act
    const argv = await argvFor({ fast: true, compactAt: 120_000 });

    // Assert
    should(settingsArguments(argv)).containEql('--compact-at=120000');
    should(settingsArguments(argv)).not.eql(settingsArguments(await argvFor({ fast: true, compactAt: 130_000 })));
    should(launchedCompactAt(argv)).equal(120_000);
    should(launchedCompactAt(await argvFor({ fast: true }))).equal('auto');
  });

  it('should call a changed login a different launch', async () => {
    should(settingsArguments(await argvFor({ fast: true }))).not.eql(
      settingsArguments(await argvFor({ fast: true }, FIXED.replace(SYNTHETIC, 'rotated'))),
    );
  });
});

describe('SessionLaunchService with a login that pins its environment', () => {
  const ID = parseSessionId('s1');
  const planner = new SessionPlanner({
    startWait: defaultStartWaitPolicy,
    contextWindowOverrides: {},
    namePrefix: 'fyd',
    remoteControlPrefix: 'fyd',
  });

  const ports = (files: LaunchOverlayFiles | undefined) => {
    const recorded: RecordedLaunch[] = [];
    const subject: LaunchSubject = {
      config: launchConfig({ launchFast: true }),
      state: launchState(),
      command: [WRAPPER, '--model', 'claude-opus-5'],
    };
    const value: SessionLaunchPorts = {
      subject: async () => subject,
      account: async () => ({ account: launchAccount(), executable: WRAPPER }),
      planner,
      readableFolders: () => [],
      fixedSettings: async () => FIXED,
      ...(files === undefined ? {} : { overlayFiles: files }),
      settings: async () => 'digest',
      transcriptStarted: async () => false,
      authorize: (_executable, argv) => argv,
      record: async (_id, launch) => {
        recorded.push(launch);
      },
    };
    return { value, recorded };
  };

  it('should leave the credential out of the argv it runs AND the command it records', async () => {
    // Arrange
    const files = new Files();
    const { value, recorded } = ports(files);

    // Act
    const argv = await new SessionLaunchService(value).relaunch(ID);

    // Assert
    should(argv?.join('\u0000')).not.containEql(SYNTHETIC);
    should(JSON.stringify(recorded)).not.containEql(SYNTHETIC);
    should(recorded[0]?.command.at(-2)).equal('--settings');
    should(recorded[0]?.command.at(-1)).startWith(`${DIRECTORY}/launch-`);
    should(files.asked.map(asked => asked.write)).eql([true]);
  });

  it('should only look where the file is when it asks whether a session is stale', async () => {
    // Arrange
    const files = new Files();

    // Act
    await new SessionLaunchService(ports(files).value).drift(ID);

    // Assert
    should(files.asked.map(asked => asked.write)).eql([false]);
  });

  it('should leave a session to its record when no file can be written for it', async () => {
    // Act
    const argv = await new SessionLaunchService(ports(undefined).value).relaunch(ID);

    // Assert
    should(argv).be.undefined();
  });
});

describe('adoptedLaunchArgv with a login that pins its environment', () => {
  it('should leave the credential out of the adopted conversation’s argv', async () => {
    // Arrange
    const files = new Files();

    // Act
    const launch = await adoptedLaunchArgv({
      parts: parts(),
      accountDefault: 150_000,
      window: undefined,
      fixedSettings: async () => FIXED,
      overlayFiles: files,
    });

    // Assert
    should(launch.kind).equal('argv');
    should(launch.kind === 'argv' ? launch.argv.join('\u0000') : SYNTHETIC).not.containEql(SYNTHETIC);
    should(files.asked).have.length(1);
  });

  it('should refuse an adoption whose file cannot be written, never inline it', async () => {
    // Act
    const launch = await adoptedLaunchArgv({
      parts: parts(),
      accountDefault: 150_000,
      window: undefined,
      fixedSettings: async () => FIXED,
    });

    // Assert
    should(launch.kind).equal('unreadable');
  });
});
