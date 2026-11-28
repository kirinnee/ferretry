/**
 * E-276 0a: fixed-layer PRECEDENCE — what `applyFixedLayer` does when a person's profile fights the fixed layer a launch ends with.
 * Each harness is handed a profile whose flags, settings document and instruction all conflict with what the fixed layer decides
 * (the permission mode, the sandbox, the approval policy, the questions switch, Remote Control, the tools server, the person's own
 * instruction), in TWO layers so every reported override names the layer that lost. The goldens pin the launch arguments that
 * survive, the settings written over the profile's, and the exact list of what was overridden — so a move that drops a flag from a
 * harness's superseded table, or reads the wrong table for a harness, turns a golden red.
 */
import { describe, it } from 'bun:test';
import { applyFixedLayer, fixedLayerFor } from '../../../daemon/lib/account/fixed-layer.ts';
import { REAL_KITS } from '../../support/real-kits.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { expectGolden } from './support/golden.ts';
import { FY_COMMAND } from './support/world.ts';

const CWD = '/golden/launch-folder';

/** Everything a person could write that the fixed layer decides, per harness: the first layer's flags, the second's, and a settings document. */
const CONFLICTS = {
  claude: {
    first: [
      '--verbose',
      '--permission-mode',
      'plan',
      '--permission-mode=acceptEdits',
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--append-system-prompt',
      'be terse',
      '--disallowed-tools=WebFetch',
    ],
    second: ['--append-system-prompt=always test', '--mcp-config=person.json', '--permission-mode'],
    document: {
      permissions: { defaultMode: 'plan', allow: ['Bash(ls)'] },
      remoteControlAtStartup: true,
      skipAutoPermissionPrompt: false,
      theme: 'dark',
    },
  },
  codex: {
    first: [
      '--full-auto',
      '-a',
      'untrusted',
      '--ask-for-approval=on-failure',
      '-s',
      'read-only',
      '--sandbox',
      'workspace-write',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'approval_policy="untrusted"',
      '--config=sandbox_mode=read-only',
      '-c',
      'model_reasoning_effort="high"',
    ],
    second: [
      '-c',
      'developer_instructions="be terse"',
      '-c',
      'mcp_servers.ferretry.command="/evil"',
      '-c',
      'mcp_servers.github.command="gh"',
      '--no-alt-screen',
      '--search',
    ],
    document: {
      approval_policy: { nested: 1 },
      sandbox_mode: 'read-only',
      developer_instructions: 'prefer bun',
      mcp_servers: { ferretry: { command: '/evil' }, github: { command: 'gh' } },
      model_reasoning_effort: 'high',
    },
  },
} as const;

/** A profile of two settings layers (the second carrying the document), resolved for `harness`. */
function conflictingProfile(harness: 'claude' | 'codex') {
  const conflict = CONFLICTS[harness];
  const model = parseAccountModel({
    version: 1,
    components: {
      settings: {
        first: { harness, flags: [...conflict.first] },
        second: { harness, flags: [...conflict.second], file: 'second' },
      },
    },
    profiles: { agent: { layers: ['settings/first', 'settings/second'] } },
  });
  const result = resolveProfile({
    model,
    profile: 'agent',
    harness,
    settingsBodies: { second: conflict.document },
  });
  if (!result.ok) throw new Error('the conflicting profile must resolve');
  return result.resolved;
}

describe('fixed-layer precedence goldens', () => {
  for (const harness of ['claude', 'codex'] as const) {
    for (const permissions of ['auto', 'skip'] as const) {
      it(`should let the ${harness} fixed layer (${permissions}) win over a profile's flags, settings and instruction exactly as the base does`, () => {
        const layer = fixedLayerFor(
          harness === 'claude'
            ? {
                harness,
                agentPermissions: permissions,
                cwd: CWD,
                acceptsAutoPermissionMode: true,
                fyCommand: FY_COMMAND,
              }
            : { harness, agentPermissions: permissions, cwd: CWD, fyCommand: FY_COMMAND },
          REAL_KITS,
        );
        if (!layer.ok) throw new Error('the fixed layer must be available');
        const launch = applyFixedLayer(conflictingProfile(harness), layer.layer);
        expectGolden(`precedence/${harness}-${permissions}`, {
          args: launch.args,
          settings: launch.settings,
          overridden: launch.overridden,
        });
      });
    }
  }
});
