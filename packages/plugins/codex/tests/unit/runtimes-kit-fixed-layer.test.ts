/** What Codex hands Runtimes for the layer a launched agent gets last (E-276 PR 3). */
import { describe, expect, it } from 'bun:test';
import {
  FERRETRY_MCP_ENV_VARS,
  type KitFixedLayerInput,
  type KitFixedLayerResult,
  type KitFixedPurpose,
} from '@ferretry/plugin-runtimes/contract';
import { codexRuntimesKit } from '../../daemon/lib/runtimes-kit/index.ts';
import {
  CODEX_HIDDEN_NOTICES,
  codexNoticeOverride,
  codexToolsServer,
  codexTrustOverride,
} from '../../daemon/lib/runtimes-kit/fixed-layer.ts';

const FY = '/opt/fy/bin/fy';
const INPUT: KitFixedLayerInput = {
  agentPermissions: 'auto',
  cwd: '/work/repo',
  fyCommand: FY,
  acceptsAutoPermissionMode: false,
  instruction: 'the words every agent is told',
};
const built = (input: Partial<KitFixedLayerInput> = {}): KitFixedLayerResult => {
  const result = codexRuntimesKit.fixedLayer?.({ ...INPUT, ...input });
  if (result === undefined) throw new Error('the Codex kit gives no fixed layer');
  return result;
};
const layerOf = (input: Partial<KitFixedLayerInput> = {}) => {
  const result = built(input);
  if (!result.ok) throw new Error(result.refusal.message);
  return result.layer;
};

describe('the Codex fixed layer', () => {
  it('should name the approval policy and sandbox explicitly, trust the launch folder alone and place the tools server and the given words', () => {
    expect(layerOf().args).toEqual([
      '-c',
      'approval_policy="on-request"',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'projects={"/work/repo"={trust_level="trusted"}}',
      '--no-alt-screen',
      '-c',
      'notice={hide_full_access_warning=true,hide_world_writable_warning=true,hide_rate_limit_model_nudge=true,hide_gpt5_1_migration_prompt=true,"hide_gpt-5.1-codex-max_migration_prompt"=true}',
      '-c',
      `mcp_servers.ferretry.command="${FY}"`,
      '-c',
      'mcp_servers.ferretry.args=["mcp","serve"]',
      '-c',
      'mcp_servers.ferretry.env_vars=["FY_HOME","FY_URL","FY_SESSION_ID","FY_SESSION_TOKEN","FY_SESSION_BOARD_CAPABILITY"]',
      '-c',
      'developer_instructions="the words every agent is told"',
    ]);
    expect(layerOf({ agentPermissions: 'skip' }).args.slice(0, 4)).toEqual([
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="danger-full-access"',
    ]);
  });

  it('should list every entry the lock shows, in order, with the instruction last', () => {
    const layer = layerOf();
    const purposes: KitFixedPurpose[] = [
      'permission-mode',
      'permission-mode',
      'trust',
      'no-alt-screen',
      ...CODEX_HIDDEN_NOTICES.map((): KitFixedPurpose => 'one-time-prompts'),
      'tools',
      'instructions',
    ];
    expect(layer.entries.map(entry => entry.purpose)).toEqual(purposes);
    expect(layer.entries.at(-1)).toEqual({
      purpose: 'instructions',
      target: 'settings',
      path: ['developer_instructions'],
      value: 'the words every agent is told',
    });
    expect(layer.entries[2]).toEqual({
      purpose: 'trust',
      target: 'settings',
      path: ['projects', '/work/repo', 'trust_level'],
      value: 'trusted',
    });
  });

  it('should spell a multi-line instruction as one TOML string, control characters as \\u escapes', () => {
    expect(layerOf({ instruction: 'a "b"\nc' }).args.at(-1)).toBe('developer_instructions="a \\"b\\"\\u000ac"');
  });

  it('should forbid pkill and killall in a rules file and nowhere else, whatever the mode', () => {
    for (const agentPermissions of ['auto', 'skip'] as const) {
      const layer = layerOf({ agentPermissions });
      expect(layer.rules).toMatch(/prefix_rule\(pattern=\[.pkill.\], decision=.forbidden./);
      expect(layer.rules).toMatch(/prefix_rule\(pattern=\[.killall.\], decision=.forbidden./);
      expect(layer.rules?.split('\n').filter(line => line.startsWith('prefix_rule'))).toHaveLength(2);
      expect(layer.args.join(' ')).not.toMatch(/kill/);
    }
  });

  it('should have no refusal, no Claude overlay and no config json', () => {
    const layer = layerOf();
    expect(layer.settingsOverlay).toBeUndefined();
    expect(layer.configJson).toBeUndefined();
    expect(built({ acceptsAutoPermissionMode: false }).ok).toBe(true);
  });

  it('should write the trust override as an inline table, whatever the folder holds', () => {
    expect(codexTrustOverride('/a "b"')).toBe('projects={"/a \\"b\\""={trust_level="trusted"}}');
    expect(codexNoticeOverride()).toContain('"hide_gpt-5.1-codex-max_migration_prompt"=true');
  });

  it('should hand the tools server the session credential and never the host admin token', () => {
    expect(FERRETRY_MCP_ENV_VARS).not.toContain('FY_TOKEN');
    expect(codexToolsServer(FY)).toEqual({ command: FY, args: ['mcp', 'serve'], env_vars: [...FERRETRY_MCP_ENV_VARS] });
  });
});
