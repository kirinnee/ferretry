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

/**
 * Top-level `config.toml` keys of the ferret's OWN home that a setting of the person's (a settings item) may still
 * override: written only when no selected item says otherwise. O11b, Codex 0.166.0 binary strings:
 * `check_for_update_on_startup = false` is the "Update available" screen, which a ferret must never stop on (Ferretry
 * applies updates). It sits outside the launch fingerprint, which is the arguments above.
 */
export const CODEX_CONFIG_DEFAULTS = { check_for_update_on_startup: false } as const;

/**
 * The launch's permission as EXPLICIT flags, attached so no word before them can take either as its value. Codex refuses a
 * repeated `--ask-for-approval` or `--sandbox` (and `--full-auto` / `--yolo` / the bypass switch beside them), so a
 * settings item that slipped one past `launchFlagsKept` makes the start fail instead of loosening it, and an explicit
 * flag outranks a `-c` pair or a profile. Deliberately NOT part of {@link codexFixedArguments}: the `permission-mode`
 * section of the launch record already fingerprints the mode these spell.
 */
export function codexPermissionArguments(permissionMode: HarnessConfig['permissionMode']): readonly string[] {
  const { approvalPolicy, sandboxMode } = CODEX_PERMISSIONS[permissionMode];
  return [`--ask-for-approval=${approvalPolicy}`, `--sandbox=${sandboxMode}`];
}

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
 * `CODEX_QUESTIONS_FEATURE`): no ferret is given it, so it is only ever named here to be turned off.
 */
export const CODEX_QUESTIONS_FEATURE = 'default_mode_request_user_input';

/**
 * The question tool (owner !A527, again 2026-11-17: "make sure ferrets dont use question tool"): NEVER enabled, for any
 * ferret, with no setting to turn it back on, so Codex keeps `request_user_input` to its Plan mode and a ferret asks
 * through the agenda.
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
export const CODEX_QUESTIONS_OFF: readonly string[] = ['-c', `features.${CODEX_QUESTIONS_FEATURE}=false`];
