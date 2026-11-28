/** What Claude hands Runtimes for the layer a launched agent gets last (E-276 PR 2). */
import { describe, expect, it } from 'bun:test';
import type { KitFixedLayerInput, KitFixedLayerResult, KitFixedPurpose } from '@ferretry/plugin-runtimes/contract';
import { CLAUDE_PROMPTS_SEEN } from '../../daemon/lib/harness/fixed-layer.ts';
import { CLAUDE_NO_QUESTIONS_FLAG } from '../../daemon/lib/harness/launch.ts';
import { claudeRuntimesKit } from '../../daemon/lib/runtimes-kit/index.ts';
import { claudeToolsConfig } from '../../daemon/lib/runtimes-kit/fixed-layer.ts';

const FY = '/opt/fy/bin/fy';
const INPUT: KitFixedLayerInput = {
  agentPermissions: 'auto',
  cwd: '/work/repo',
  fyCommand: FY,
  acceptsAutoPermissionMode: true,
  instruction: 'the words every agent is told',
};
const built = (input: Partial<KitFixedLayerInput> = {}): KitFixedLayerResult => {
  const result = claudeRuntimesKit.fixedLayer?.({ ...INPUT, ...input });
  if (result === undefined) throw new Error('the Claude kit gives no fixed layer');
  return result;
};
const layerOf = (input: Partial<KitFixedLayerInput> = {}) => {
  const result = built(input);
  if (!result.ok) throw new Error(result.refusal.message);
  return result.layer;
};

describe('the Claude fixed layer', () => {
  it('should name Auto explicitly, withhold the question tool and place the tools server and the given words', () => {
    const layer = layerOf();
    expect(layer.args).toEqual([
      '--permission-mode',
      'auto',
      CLAUDE_NO_QUESTIONS_FLAG,
      `--mcp-config=${JSON.stringify(claudeToolsConfig(FY))}`,
      '--append-system-prompt=the words every agent is told',
    ]);
    const purposes: KitFixedPurpose[] = [
      'permission-mode',
      'trust',
      'onboarding',
      'remote-control',
      ...Object.keys(CLAUDE_PROMPTS_SEEN).map((): KitFixedPurpose => 'one-time-prompts'),
      'skip-prompt',
      'no-questions',
      'tools',
      'instructions',
    ];
    expect(layer.entries.map(entry => entry.purpose)).toEqual(purposes);
    expect(layer.entries.at(-1)).toEqual({
      purpose: 'instructions',
      target: 'launch',
      path: ['--append-system-prompt'],
      value: 'the words every agent is told',
    });
  });

  it('should name the mode in the --settings overlay, with Remote Control off and pkill and killall refused', () => {
    expect(layerOf().settingsOverlay).toEqual({
      permissions: { defaultMode: 'auto', deny: ['Bash(pkill:*)', 'Bash(killall:*)'] },
      remoteControlAtStartup: false,
      skipAutoPermissionPrompt: true,
    });
    expect(layerOf({ agentPermissions: 'skip' }).settingsOverlay).toEqual({
      permissions: { defaultMode: 'bypassPermissions', deny: ['Bash(pkill:*)', 'Bash(killall:*)'] },
      remoteControlAtStartup: false,
      skipDangerousModePermissionPrompt: true,
    });
  });

  it('should re-assert onboarding, the seen screens and trust for the launch folder alone', () => {
    expect(layerOf({ cwd: '/w/x' }).configJson).toEqual({
      hasCompletedOnboarding: true,
      ...CLAUDE_PROMPTS_SEEN,
      projects: { '/w/x': { hasTrustDialogAccepted: true } },
    });
  });

  it('should refuse Auto, word for word, on a Claude that does not accept it, and Skip never needs it', () => {
    const refused = built({ acceptsAutoPermissionMode: false });
    expect(refused).toEqual({
      ok: false,
      refusal: {
        kind: 'claude-auto-mode-unsupported',
        message:
          "Claude Code on this machine does not accept Auto mode (--permission-mode auto), so Ferretry won't launch this agent runtime. Update Claude Code, or switch this machine's Agent permissions to Skip all permission checks.",
      },
    });
    expect(built({ agentPermissions: 'skip', acceptsAutoPermissionMode: false }).ok).toBe(true);
  });

  it('should never hand the tools server the host admin token', () => {
    expect(claudeToolsConfig(FY)).toEqual({
      mcpServers: { ferretry: { type: 'stdio', command: FY, args: ['mcp', 'serve'], env: { FY_TOKEN: '' } } },
    });
  });
});
