import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@ferretry/std';
import should from 'should';
import { CLAUDE_HOME_ENV, fixedLayer } from '../../../daemon/lib/harness/fixed-layer.ts';
import { compareLaunchSettings, launchSettingsRecord } from '../../../daemon/lib/harness/launch-settings.ts';
import { homeText, launchCommand } from '../../../daemon/lib/harness/launch.ts';
import { mergeClaudeJson } from '../../../daemon/lib/harness/claude-json.ts';

/**
 * O11: every screen Claude can stop a ferret on that has a SAFE key is answered in the ferret's OWN home. Folder trust,
 * which loosens something, is answered for the ferret's working folder ONLY. The project-MCP approval has no safe key
 * (`enableAllProjectMcpServers` approves every server of a folder, and 5.0 has no owner-approved per-server list), so it
 * is NOT written: that screen goes to the Warden's one notice.
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

  it('should trust ONLY the ferret’s working folder, and NEVER approve project MCP servers', () => {
    // Act
    const json = JSON.parse(home('skip', '/work/repo/sub').claudeJson);

    // Assert: one project entry, the cwd — not a parent, not a wildcard — holding trust and nothing that approves a server
    should(Object.keys(json.projects)).eql(['/work/repo/sub']);
    should(json.projects['/work/repo/sub']).eql({ hasTrustDialogAccepted: true });
    should(fixedLayer('auto', '/work/repo').claudeJson.projects['/work/repo']).not.have.property(
      'enableAllProjectMcpServers',
    );
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
    should(merged.projects['/work/repo']).eql({ hasTrustDialogAccepted: true });
  });

  it('should leave an owner’s own enableAllProjectMcpServers value in the entry exactly as it is, false or true', () => {
    for (const owner of [false, true]) {
      // Arrange: the owner (or Claude, on their answer) already decided for this folder
      const existing = JSON.stringify({ projects: { '/work/repo': { enableAllProjectMcpServers: owner } } });

      // Act
      const merged = JSON.parse(mergeClaudeJson(existing, home('auto', '/work/repo').claudeJson) as string);

      // Assert
      should(merged.projects['/work/repo']).eql({ enableAllProjectMcpServers: owner, hasTrustDialogAccepted: true });
    }
  });
});
