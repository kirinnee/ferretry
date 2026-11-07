import { describe, it } from 'bun:test';
import should from 'should';
import { adoptedLaunchArgv } from '../../../../../daemon/lib/session/launch/index.ts';

const WRAPPER = '/fleet/bin/claude-auto-boot';

const parts = (harness: 'claude' | 'codex' = 'claude') => ({
  harness,
  executable: WRAPPER,
  remoteControl: [],
  transcript: ['--resume', 'abc'],
  readableFolders: [],
  model: 'claude-opus-5',
  harnessFlags: [],
});

const settingsOf = (argv: readonly string[]): Record<string, unknown> =>
  JSON.parse(argv[argv.indexOf('--settings') + 1] as string) as Record<string, unknown>;

describe('adoptedLaunchArgv', () => {
  it('should carry the login’s default trigger and its fixed settings into a Claude first launch', async () => {
    // Act
    const launch = await adoptedLaunchArgv({
      parts: parts(),
      accountDefault: 250_000,
      window: 1_000_000,
      fixedSettings: async () => '{"disableAllHooks":false}',
    });

    // Assert
    should(launch.kind).equal('argv');
    const argv = launch.kind === 'argv' ? launch.argv : [];
    should(settingsOf(argv)).eql({ disableAllHooks: false, autoCompactWindow: 250_000 });
    should(argv).containEql('--resume');
  });

  it('should carry it as a -c pair on Codex without reading any fixed settings', async () => {
    // Act
    const launch = await adoptedLaunchArgv({
      parts: parts('codex'),
      accountDefault: 250_000,
      window: 1_000_000,
      fixedSettings: async () => {
        throw new Error('not needed');
      },
    });

    // Assert
    should(launch.kind === 'argv' ? launch.argv : []).containEql('model_auto_compact_token_limit=250000');
  });

  it('should add nothing when the login has no default, or one the model’s window cannot honour', async () => {
    // Act
    const none = await adoptedLaunchArgv({
      parts: parts(),
      accountDefault: undefined,
      window: 1_000_000,
      fixedSettings: async () => '',
    });
    const tooBig = await adoptedLaunchArgv({
      parts: parts(),
      accountDefault: 400_000,
      window: 200_000,
      fixedSettings: async () => '',
    });

    // Assert
    should(none.kind === 'argv' ? none.argv : ['x']).not.containEql('--settings');
    should(tooBig.kind === 'argv' ? tooBig.argv : ['x']).not.containEql('--settings');
  });

  it('should refuse when the login’s fixed settings cannot be read, rather than launch without the trigger', async () => {
    // Act
    const launch = await adoptedLaunchArgv({
      parts: parts(),
      accountDefault: 250_000,
      window: 1_000_000,
      fixedSettings: async () => undefined,
    });

    // Assert
    should(launch.kind).equal('unreadable');
  });

  it('should refuse when the fixed settings are not a JSON object', async () => {
    // Act
    const launch = await adoptedLaunchArgv({
      parts: parts(),
      accountDefault: 250_000,
      window: 1_000_000,
      fixedSettings: async () => '[1]',
    });

    // Assert
    should(launch.kind).equal('unreadable');
  });

  it('should let any other failure while building the argv through', async () => {
    // Arrange
    const broken = {
      ...parts(),
      remoteControl: {
        [Symbol.iterator]: () => {
          throw new Error('boom');
        },
      },
    };

    // Act / Assert
    await should(
      adoptedLaunchArgv({
        parts: broken as never,
        accountDefault: 250_000,
        window: 1_000_000,
        fixedSettings: async () => '',
      }),
    ).be.rejectedWith('boom');
  });
});
