import { createHash } from 'node:crypto';
import { describe, it } from 'bun:test';
import { EMPTY_RUNTIME_IDS, evaluateConfigFiles, type FleetLayout, materialiseFleet } from '@ferretry/fleet';
import should from 'should';
import { currentLaunchCompactAt } from '../../../../src/lib/session/launch/index.ts';

const LAYOUT: FleetLayout = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/person/.claude', codex: '/home/person/.codex' },
};

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The compact-at a launch on `runtime` gets, from YAML files read by the real loader and materialised. */
function launchOn(
  runtimeLine: string,
  profileLine: string,
  own: number | 'auto' | undefined,
  window: number | undefined,
): number | undefined {
  const evaluation = evaluateConfigFiles({
    files: [
      { path: 'logins/you.yaml', text: 'harness: claude\nstore: host\n' },
      { path: 'components/instructions/main.yaml', text: 'file: instructions/main.md\n' },
      { path: 'profiles/lead.yaml', text: `contents:\n  - instructions/main\n${profileLine}` },
      { path: 'runtimes/claude-lead.yaml', text: `credential: you\nprofile: lead\nagent: true\n${runtimeLine}` },
    ],
    accepted: {},
    digest,
  });
  should(evaluation.issues).deepEqual([]);
  const plan = materialiseFleet({
    model: evaluation.effective.model,
    layout: LAYOUT,
    ids: EMPTY_RUNTIME_IDS,
    mint: () => '00000000-0000-4000-8000-00000000000a',
    generatedAt: '2026-10-13T08:00:00.000Z',
    claudeStatusline: () => "'fy' statusline",
    fyCommand: '/opt/ferretry/bin/fy',
    hostCodexHome: '/home/person/.codex',
    acceptsAutoPermissionMode: true,
  });
  const account = plan.manifest.accounts?.find(entry => entry.displayName === 'claude-lead');
  return currentLaunchCompactAt({ compactAt: own }, account?.compactAt, window);
}

describe('compact-at precedence from YAML files', () => {
  it('should use the profile’s value when the runtime and the ferret say nothing', () => {
    should(launchOn('', 'compactAt: 250000\n', undefined, 1_000_000)).equal(250_000);
  });

  it('should prefer the runtime’s value over the profile’s', () => {
    should(launchOn('compactAt: 300000\n', 'compactAt: 250000\n', undefined, 1_000_000)).equal(300_000);
  });

  it('should prefer the ferret’s own value over both', () => {
    should(launchOn('compactAt: 300000\n', 'compactAt: 250000\n', 400_000, 1_000_000)).equal(400_000);
  });

  it('should let a ferret’s explicit auto beat the profile', () => {
    should(launchOn('', 'compactAt: 250000\n', 'auto', 1_000_000)).be.undefined();
  });

  it('should let a runtime’s explicit auto beat the profile', () => {
    should(launchOn('compactAt: auto\n', 'compactAt: 250000\n', undefined, 1_000_000)).be.undefined();
  });

  it('should fall back to auto when the profile’s value is larger than the model window', () => {
    should(launchOn('', 'compactAt: 500000\n', undefined, 200_000)).be.undefined();
  });

  it('should be auto when no one sets it', () => {
    should(launchOn('', '', undefined, 1_000_000)).be.undefined();
  });
});
