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
 * `CODEX_QUESTIONS_FEATURE`): it is given only to an interactive ferret, and only when the owner opted in.
 */
export const CODEX_QUESTIONS_FEATURE = 'default_mode_request_user_input';

/** The explicit OFF: a `-c` override beats `config.toml`, so a settings component's `features` entry cannot turn it on. */
export const CODEX_QUESTIONS_OFF: readonly string[] = ['-c', `features.${CODEX_QUESTIONS_FEATURE}=false`];

/**
 * The question tool (owner !A527: no ferret stops on a prompt only the pane shows): NOT enabled by default, an
 * interactive ferret included, so Codex keeps `request_user_input` to its Plan mode and a ferret asks through the
 * agenda. The `questionTool` setting (`config/harness-codex.yaml`) is the one way back: with it on, an INTERACTIVE
 * ferret (it has an owner at the pane) gets `--enable default_mode_request_user_input`; an auto one, or one with no
 * mode, never does.
 *
 * "Not enabled" is an explicit OFF, never just an omitted `--enable`: a runtime-selected settings component may carry
 * `features.default_mode_request_user_input = true`, which `prepareHome` writes into `config.toml`, and an omitted flag
 * would leave the tool on. `-c features.<name>=false` is the spelling because a `-c` override always beats
 * `config.toml` and it is the form this repo's fixtures already launch Codex with (`-c model=…`, `-c projects=…`);
 * no doc or fixture here shows `--disable`, so it is not relied on.
 *
 * Deliberately NOT part of {@link codexFixedArguments}, whose fingerprint is the launch record's `fixed-layer`
 * section, so a change can never make a recorded launch read as outdated.
 */
export function codexQuestionArguments(
  mode: 'interactive' | 'auto' | undefined,
  questionTool: boolean,
): readonly string[] {
  return questionTool && mode === 'interactive' ? ['--enable', CODEX_QUESTIONS_FEATURE] : CODEX_QUESTIONS_OFF;
}
