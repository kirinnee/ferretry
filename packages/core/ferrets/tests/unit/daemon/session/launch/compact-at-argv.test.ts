import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildLaunchArgv,
  currentLaunchCompactAt,
  launchedCompactAt,
  settingsArguments,
} from '../../../../src/lib/session/launch/index.ts';

const WRAPPER = '/fleet/bin/claude-auto-boot';

/** The launch arguments the fast-mode overlay adds, read off a full launch argv that names nothing else. */
const fastLaunchArguments = (
  harness: 'claude' | 'codex',
  fast: boolean | undefined,
  fixedSettings: string | undefined,
): readonly string[] =>
  buildLaunchArgv({
    harness,
    executable: 'wrapper',
    remoteControl: [],
    transcript: [],
    readableFolders: [],
    harnessFlags: [],
    ...(fast === undefined ? {} : { fast }),
    ...(fixedSettings === undefined ? {} : { fixedSettings }),
  }).slice(1);

const claudeParts = (extra: Record<string, unknown> = {}) => ({
  harness: 'claude' as const,
  executable: WRAPPER,
  remoteControl: [],
  transcript: [],
  readableFolders: [],
  model: 'claude-opus-5',
  effort: undefined,
  harnessFlags: [],
  ...extra,
});

const settingsOf = (argv: readonly string[]): Record<string, unknown> =>
  JSON.parse(argv[argv.indexOf('--settings') + 1] as string) as Record<string, unknown>;

describe('buildLaunchArgv with a compaction trigger', () => {
  it('should leave the argv alone when no trigger is named', () => {
    // Act
    const argv = buildLaunchArgv(claudeParts());

    // Assert
    should(argv).not.containEql('--settings');
  });

  it('should hand Claude the trigger as autoCompactWindow in its one --settings overlay', () => {
    // Act
    const argv = buildLaunchArgv(claudeParts({ compactAt: 250_000 }));

    // Assert
    should(settingsOf(argv)).deepEqual({ autoCompactWindow: 250_000 });
  });

  it('should carry the login’s fixed settings, fast mode and the trigger in ONE overlay', () => {
    // Act
    const argv = buildLaunchArgv(claudeParts({ compactAt: 250_000, fast: true, fixedSettings: '{"theme":"dark"}' }));

    // Assert
    should(argv.filter(token => token === '--settings')).have.length(1);
    should(settingsOf(argv)).deepEqual({ theme: 'dark', fastMode: true, autoCompactWindow: 250_000 });
  });

  it('should hand Codex the trigger as a -c override, after its fast tier', () => {
    // Act
    const argv = buildLaunchArgv({
      ...claudeParts({ compactAt: 400_000, fast: true }),
      harness: 'codex' as const,
    });

    // Assert
    should(argv.slice(-4)).eql(['-c', 'service_tier="priority"', '-c', 'model_auto_compact_token_limit=400000']);
  });

  it('should keep fast mode alone exactly as it was', () => {
    // Act / Assert
    should(fastLaunchArguments('claude', true, undefined)).eql(['--settings', '{"fastMode":true}']);
    should(fastLaunchArguments('codex', false, undefined)).eql(['-c', 'service_tier="default"']);
  });
});

describe('settingsArguments with a compaction trigger', () => {
  it('should still ignore fast mode, a run fact', () => {
    // Act
    const kept = settingsArguments(buildLaunchArgv(claudeParts({ fast: true })));

    // Assert
    should(kept).not.containEql('--settings');
    should(kept.some(token => token.startsWith('--compact-at'))).be.false();
  });

  it('should keep the trigger as a marker so changing it reads as stale, whatever fast mode says', () => {
    // Act
    const asLaunched = settingsArguments(buildLaunchArgv(claudeParts({ compactAt: 250_000, fast: true })));
    const afterFastToggle = settingsArguments(buildLaunchArgv(claudeParts({ compactAt: 250_000, fast: false })));
    const afterChange = settingsArguments(buildLaunchArgv(claudeParts({ compactAt: 400_000, fast: true })));
    const afterAuto = settingsArguments(buildLaunchArgv(claudeParts({ fast: true })));

    // Assert
    should(asLaunched).containEql('--compact-at=250000');
    should(afterFastToggle).eql(asLaunched);
    should(afterChange).not.eql(asLaunched);
    should(afterAuto).not.eql(asLaunched);
  });

  it('should keep a Codex trigger pair, which is a setting', () => {
    // Act
    const kept = settingsArguments(
      buildLaunchArgv({ ...claudeParts({ compactAt: 300_000 }), harness: 'codex' as const }),
    );

    // Assert
    should(kept).eql([WRAPPER, '-c', 'model_auto_compact_token_limit=300000']);
  });
});

describe('currentLaunchCompactAt', () => {
  it('should prefer the ferret’s own number over its login’s default', () => {
    // Act / Assert
    should(currentLaunchCompactAt({ compactAt: 250_000 }, 400_000, 1_000_000)).equal(250_000);
  });

  it('should fall back to the login’s default when the ferret says nothing', () => {
    // Act / Assert
    should(currentLaunchCompactAt({}, 400_000, 1_000_000)).equal(400_000);
  });

  it('should let an explicit auto on the ferret beat a login default', () => {
    // Act / Assert
    should(currentLaunchCompactAt({ compactAt: 'auto' }, 400_000, 1_000_000)).be.undefined();
  });

  it('should be nothing when neither says anything or the default is auto', () => {
    // Act / Assert
    should(currentLaunchCompactAt({}, undefined, 1_000_000)).be.undefined();
    should(currentLaunchCompactAt({}, 'auto', 1_000_000)).be.undefined();
  });
});

describe('currentLaunchCompactAt against the window', () => {
  it('should drop a login default larger than the window to auto instead of failing the launch', () => {
    // Act / Assert
    should(currentLaunchCompactAt({}, 400_000, 200_000)).be.undefined();
  });

  it('should drop the ferret’s own value when a model change left it larger than the window', () => {
    // Act / Assert
    should(currentLaunchCompactAt({ compactAt: 400_000 }, undefined, 200_000)).be.undefined();
  });

  it('should keep a value that fits, and a value when the window is unknown', () => {
    // Act / Assert
    should(currentLaunchCompactAt({}, 150_000, 200_000)).equal(150_000);
    should(currentLaunchCompactAt({}, 400_000, undefined)).equal(400_000);
  });
});

describe('settingsArguments with unrelated inline settings', () => {
  const overlay = (settings: Record<string, unknown>): readonly string[] => [
    WRAPPER,
    '--settings',
    JSON.stringify(settings),
  ];

  it('should see a change to a setting that rides beside the trigger', () => {
    // Act
    const before = settingsArguments(overlay({ autoCompactWindow: 250_000, disableAllHooks: false }));
    const after = settingsArguments(overlay({ autoCompactWindow: 250_000, disableAllHooks: true }));

    // Assert
    should(before).not.eql(after);
    should(before).containEql('--compact-at=250000');
  });

  it('should still ignore fast mode beside the trigger and the other settings', () => {
    // Act
    const fast = settingsArguments(overlay({ disableAllHooks: false, fastMode: true, autoCompactWindow: 250_000 }));
    const standard = settingsArguments(
      overlay({ disableAllHooks: false, fastMode: false, autoCompactWindow: 250_000 }),
    );

    // Assert
    should(fast).eql(standard);
  });
});

describe('launchedCompactAt', () => {
  it('should read Claude’s autoCompactWindow from the inline overlay', () => {
    // Act / Assert
    should(launchedCompactAt(buildLaunchArgv(claudeParts({ compactAt: 250_000, fast: true })))).equal(250_000);
  });

  it('should read Codex’s -c pair', () => {
    // Act / Assert
    should(
      launchedCompactAt(buildLaunchArgv({ ...claudeParts({ compactAt: 300_000 }), harness: 'codex' as const })),
    ).equal(300_000);
  });

  it('should be auto when the launch carries no trigger', () => {
    // Act / Assert
    should(launchedCompactAt(buildLaunchArgv(claudeParts({ fast: true })))).equal('auto');
    should(launchedCompactAt([WRAPPER, '--settings', '/fleet/settings.json'])).equal('auto');
    should(launchedCompactAt([WRAPPER, '--settings', '[250000]'])).equal('auto');
  });
});

describe('settingsArguments with a fast-only overlay', () => {
  const overlay = (settings: Record<string, unknown>): readonly string[] => [
    WRAPPER,
    '--settings',
    JSON.stringify(settings),
  ];

  it('should see a change to another setting beside fast mode when no trigger is named', () => {
    // Act
    const before = settingsArguments(overlay({ disableAllHooks: false, fastMode: true }));
    const after = settingsArguments(overlay({ disableAllHooks: true, fastMode: true }));

    // Assert
    should(before).not.eql(after);
    should(before.some(token => token.startsWith('--compact-at'))).be.false();
  });

  it('should still ignore fast mode itself when it rides alone with the login’s settings', () => {
    // Act
    const fast = settingsArguments(overlay({ disableAllHooks: false, fastMode: true }));
    const standard = settingsArguments(overlay({ disableAllHooks: false, fastMode: false }));

    // Assert
    should(fast).eql(standard);
  });
});

describe('launchedCompactAt when the last word wins', () => {
  it('should read the later Codex -c pair over the earlier one', () => {
    // Act
    const launched = launchedCompactAt(
      buildLaunchArgv({
        ...claudeParts({ compactAt: 250_000, harnessFlags: ['-c', 'model_auto_compact_token_limit=400000'] }),
        harness: 'codex' as const,
      }),
    );

    // Assert
    should(launched).equal(400_000);
  });

  it('should keep the earlier Codex pair when a later one is not a number', () => {
    // Act / Assert
    should(
      launchedCompactAt([
        WRAPPER,
        '-c',
        'model_auto_compact_token_limit=300000',
        '-c',
        'model_auto_compact_token_limit=x',
      ]),
    ).equal(300_000);
  });

  it('should read the later Claude overlay over the earlier one', () => {
    // Act
    const launched = launchedCompactAt(
      buildLaunchArgv(
        claudeParts({ compactAt: 250_000, harnessFlags: ['--settings', '{"autoCompactWindow":400000}'] }),
      ),
    );

    // Assert
    should(launched).equal(400_000);
  });

  it('should be auto when a later --settings replaces the overlay and names no trigger', () => {
    // Act
    const launched = launchedCompactAt(
      buildLaunchArgv(claudeParts({ compactAt: 250_000, harnessFlags: ['--settings', '{"theme":"dark"}'] })),
    );

    // Assert
    should(launched).equal('auto');
  });
});
