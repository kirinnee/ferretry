import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildLaunchArgv,
  currentLaunchCompactAt,
  fastLaunchArguments,
  settingsArguments,
} from '../../../../src/lib/session/launch/index.ts';

const WRAPPER = '/fleet/bin/claude-auto-boot';

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
    should(currentLaunchCompactAt({ compactAt: 250_000 }, 400_000)).equal(250_000);
  });

  it('should fall back to the login’s default when the ferret says nothing', () => {
    // Act / Assert
    should(currentLaunchCompactAt({}, 400_000)).equal(400_000);
  });

  it('should let an explicit auto on the ferret beat a login default', () => {
    // Act / Assert
    should(currentLaunchCompactAt({ compactAt: 'auto' }, 400_000)).be.undefined();
  });

  it('should be nothing when neither says anything or the default is auto', () => {
    // Act / Assert
    should(currentLaunchCompactAt({}, undefined)).be.undefined();
    should(currentLaunchCompactAt({}, 'auto')).be.undefined();
  });
});
