/** Copied from the current account fixed layer: machine permission, trust, notices and terminal mode. */
import type { HarnessConfig } from '../../contract/index.ts';
import { tomlString } from './toml.ts';

const CODEX_PERMISSIONS = {
  auto: { approvalPolicy: 'on-request', sandboxMode: 'workspace-write' },
  skip: { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
} as const;

const CODEX_HIDDEN_NOTICES = [
  'hide_full_access_warning',
  'hide_world_writable_warning',
  'hide_rate_limit_model_nudge',
  'hide_gpt5_1_migration_prompt',
  'hide_gpt-5.1-codex-max_migration_prompt',
] as const;

export function codexFixedArguments(permissionMode: HarnessConfig['permissionMode'], cwd: string): readonly string[] {
  const { approvalPolicy, sandboxMode } = CODEX_PERMISSIONS[permissionMode];
  return [
    '-c',
    `approval_policy=${tomlString(approvalPolicy)}`,
    '-c',
    `sandbox_mode=${tomlString(sandboxMode)}`,
    '-c',
    `projects={${tomlString(cwd)}={trust_level="trusted"}}`,
    '--no-alt-screen',
    '-c',
    `notice={${CODEX_HIDDEN_NOTICES.map(key => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)}=true`).join(',')}}`,
  ];
}
