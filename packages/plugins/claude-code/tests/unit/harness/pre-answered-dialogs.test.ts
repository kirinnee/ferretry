import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@ferretry/std';
import should from 'should';
import { CLAUDE_HOME_ENV, fixedLayer } from '../../../daemon/lib/harness/fixed-layer.ts';
import { compareLaunchSettings, launchSettingsRecord } from '../../../daemon/lib/harness/launch-settings.ts';
import { homeText, launchCommand } from '../../../daemon/lib/harness/launch.ts';
import { mergeClaudeJson } from '../../../daemon/lib/harness/claude-json.ts';

/**
 * O11: every screen Claude can stop a ferret on that has a key is answered in the ferret's OWN home, and the two that
 * loosen something (folder trust, project MCP approval) are answered for the ferret's working folder ONLY.
 */

const home = (permissionMode: 'auto' | 'skip', folder = '/work/repo') =>
  homeText({ folder, permissionMode, instructions: [], parts: [], settings: new Map(), hooks: new Map() });

describe('the screens a Claude home pre-answers', () => {
  it('should turn the self-update notice off in the launch environment, never in the --settings overlay', () => {
    for (const permissionMode of ['auto', 'skip'] as const) {
      // Act
      const argv = launchCommand({
        binary: '/opt/bin/claude',
        home: '/h/f1',
        permissionMode,
        hasMcp: false,
        questionTool: false,
        conversation: { kind: 'new', id: 'c-1' },
      });

      // Assert: set by `env` before claude runs; the overlay a project's own env must beat carries none
      should(argv.slice(0, 5)).eql([
        'env',
        '-u',
        'CLAUDE_CODE_CHILD_SESSION',
        'CLAUDE_CONFIG_DIR=/h/f1',
        'DISABLE_AUTOUPDATER=1',
      ]);
      should(JSON.parse(home(permissionMode).overlay)).not.have.property('env');
    }
  });

  it('should fingerprint the fixed environment with the fixed layer, so changing it marks a Restart', () => {
    // Arrange
    const inputs = { permissionMode: 'auto' as const, settings: new Map(), hooks: new Map() };
    const fixed = fixedLayer('auto', '/ferret-folder');
    const spell = (value: unknown): string => {
      const spelled = canonicalJson(value);
      if (!spelled.ok) throw new Error('no canonical spelling');
      return createHash('sha256').update(spelled.text, 'utf8').digest('hex');
    };

    // Act
    const record = launchSettingsRecord(inputs);

    // Assert: with the environment it is this; without it (an older launch) it is not, and compares as drifted
    should(record.sections['fixed-layer']).equal(
      spell({ settings: fixed.settings, overlay: fixed.overlay, env: CLAUDE_HOME_ENV }),
    );
    const older = {
      ...record,
      sections: { ...record.sections, 'fixed-layer': spell({ settings: fixed.settings, overlay: fixed.overlay }) },
    };
    should(compareLaunchSettings(older, record)).eql({ kind: 'drifted', sections: ['fixed-layer'] });
  });

  it('should answer the bypass warning in bypass mode and the auto-mode warning otherwise', () => {
    const bypass = fixedLayer('skip', '/w').settings as Record<string, unknown>;
    const auto = fixedLayer('auto', '/w').settings as Record<string, unknown>;
    should(bypass.skipDangerousModePermissionPrompt).equal(true);
    should('skipAutoPermissionPrompt' in bypass).equal(false);
    should(auto.skipAutoPermissionPrompt).equal(true);
    should('skipDangerousModePermissionPrompt' in auto).equal(false);
  });

  it('should answer onboarding, the Chrome onboarding and the one-time nudges', () => {
    const json = JSON.parse(home('auto').claudeJson);
    should(json.hasCompletedOnboarding).equal(true);
    should(json.hasCompletedClaudeInChromeOnboarding).equal(true);
    should(json.hasSeenAutoDefaultNudge).equal(true);
    should(json.hasSeenEffortMediumNudge).equal(true);
  });

  it('should trust ONLY the ferret’s working folder, and approve project MCP servers only in that folder’s entry', () => {
    // Act
    const json = JSON.parse(home('skip', '/work/repo/sub').claudeJson);

    // Assert: one project entry, the cwd — not a parent, not a wildcard — and the global keys carry neither
    should(Object.keys(json.projects)).eql(['/work/repo/sub']);
    should(json.projects['/work/repo/sub']).eql({ hasTrustDialogAccepted: true, enableAllProjectMcpServers: true });
    should('enableAllProjectMcpServers' in json).equal(false);
    should('hasTrustDialogAccepted' in json).equal(false);
    should(JSON.parse(home('skip').settings).enableAllProjectMcpServers).equal(undefined);
  });

  it('should leave another folder’s entry in a carried .claude.json as it was', () => {
    // Arrange: the home already holds a decision for ANOTHER folder
    const existing = JSON.stringify({ projects: { '/other': { disabledMcpjsonServers: ['x'] } } });

    // Act
    const merged = JSON.parse(mergeClaudeJson(existing, home('auto', '/work/repo').claudeJson) as string);

    // Assert
    should(merged.projects['/other']).eql({ disabledMcpjsonServers: ['x'] });
    should(merged.projects['/work/repo'].enableAllProjectMcpServers).equal(true);
  });
});
