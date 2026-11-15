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
    // Every launch keeps the sign-in in a FILE: one moved into a keyring is one the link in this home cannot reach. A `-c`
    // outranks a settings item that says `keyring`.
    '-c',
    `cli_auth_credentials_store=${tomlString('file')}`,
    '-c',
    `notice={${CODEX_HIDDEN_NOTICES.map(key => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)}=true`).join(',')}}`,
  ];
}

/**
 * Codex gates `request_user_input` outside Plan mode behind this feature (copied from the Runtimes wrapper's
 * `CODEX_QUESTIONS_FEATURE`): only an interactive ferret, who has an owner at the pane, is given it.
 */
export const CODEX_QUESTIONS_FEATURE = 'default_mode_request_user_input';

/**
 * The question tool, per ferret (O3, v4 parity with the Runtimes wrapper): an interactive ferret gets
 * `--enable default_mode_request_user_input`, an auto one (or one with no mode) gets nothing. Deliberately NOT part of
 * {@link codexFixedArguments}, whose fingerprint is the launch record's `fixed-layer` section: a ferret's mode is fixed
 * for its life, so it can never make a recorded launch read as outdated.
 */
export function codexQuestionArguments(mode: 'interactive' | 'auto' | undefined): readonly string[] {
  return mode === 'interactive' ? ['--enable', CODEX_QUESTIONS_FEATURE] : [];
}
