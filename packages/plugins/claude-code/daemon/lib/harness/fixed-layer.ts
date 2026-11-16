import type { HarnessConfig } from '../../../contract/index.ts';
import { CLAUDE_COMPACTION_HOOKS } from './compaction.ts';

// Copied from fleet/src/lib/account/fixed-layer.ts: these are seen screens, not owner choices.
export const CLAUDE_PROMPTS_SEEN = {
  hasSeenAutoDefaultNudge: true,
  hasSeenEffortMediumNudge: true,
  hasSeenEffortMediumNudgeByModel: { 'claude-opus-5': true, 'claude-fable-5-1': true },
  fullscreenUpsellSeenCount: 3,
} as const;

const QUESTION_ASKED_FILE_ENV = 'FY_QUESTION_FILE';
export const CLAUDE_QUESTION_HOOK_COMMAND = `if [ -n "$${QUESTION_ASKED_FILE_ENV}" ] && cat 2>/dev/null > "$${QUESTION_ASKED_FILE_ENV}.tmp" && mv -f "$${QUESTION_ASKED_FILE_ENV}.tmp" "$${QUESTION_ASKED_FILE_ENV}" 2>/dev/null; then :; else cat > /dev/null 2>&1; fi; exit 0`;
export const CLAUDE_QUESTION_HOOKS = {
  PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CLAUDE_QUESTION_HOOK_COMMAND }] }],
};

/**
 * `.claude.json` keys set ONLY when absent or `null` (today's `SEED_FILTER`): `claudeInChromeDefaultEnabled` is the
 * gate for Claude's browser prompt, and a home where somebody chose `true` must not be silently turned off.
 */
export const CLAUDE_JSON_DEFAULTS = {
  claudeInChromeDefaultEnabled: false,
  // O11b, Claude Code 2.1.317 binary strings: the "LSP plugin recommendation" and "Plugin recommendation" dialogs. A
  // nested key is set only where ITS leaf is absent, so a `claudeCodeHints` the person already holds keeps its keys.
  lspRecommendationDisabled: true,
  claudeCodeHints: { disabled: true },
} as const;

/**
 * `lastReleaseNotesSeen`: the "what's new" summary Claude shows once after an upgrade. It is bookkeeping, not a choice,
 * so unlike the defaults above it is set to the installed version on EVERY launch (the launch knows the version, a
 * constant cannot), and only when that version is known: a home prepared without a discovery asserts nothing.
 */
export const RELEASE_NOTES_KEY = 'lastReleaseNotesSeen';

/**
 * What a ferret's home pre-answers so that no screen of the harness's own stops it (docs/harness-dialogs.md).
 *
 * - `DISABLE_AUTOUPDATER=1` (the variable v4's harness probe sets, here in the launch's process environment — never in
 *   the `--settings` overlay, which carries no env so a project's own wins): no "update available / installing"
 *   notice or self-update in a ferret's pane. Updates are Ferretry's to apply.
 * - `projects[<cwd>].hasTrustDialogAccepted`: the "Do you trust this folder?" screen, for the ferret's OWN working
 *   folder and no other (not a parent, not `*`). It lets that folder's `.claude/settings` and hooks run.
 * - NOT `projects[<cwd>].enableAllProjectMcpServers`: it would approve EVERY server a folder's `.mcp.json` ever
 *   declares, and 5.0 has no owner-approved per-server list to write instead (v4 never wrote it either). The "New MCP
 *   server found in this project" screen is therefore left to the owner: the Warden raises ONE notice for it
 *   (docs/harness-dialogs.md), and an `enableAllProjectMcpServers` already in the home is never touched.
 */
export const CLAUDE_HOME_ENV = { DISABLE_AUTOUPDATER: '1' } as const;

/**
 * O11b (Claude Code 2.1.317 binary strings), set in the launch's process environment like {@link CLAUDE_HOME_ENV} but
 * deliberately OUTSIDE the launch-settings fingerprint: it changes what an agent may do in no way, so a ferret already
 * running never reads as outdated for it.
 *
 * - `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`: the "How is Claude doing this session?" survey.
 *
 * The two dangerous-rm switches are NOT here: they skip the check rather than answer a prompt, so they are part of
 * {@link CLAUDE_RM_WAIVER_ENV}.
 */
export const CLAUDE_PROMPT_ENV = {
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
} as const;

/**
 * Removed from the launched Claude's environment (`env -u`): a ferret started from inside a Claude Bash shell inherits
 * it, and with it set Claude treats the session as a child whose rm waivers do not apply.
 */
export const CLAUDE_UNSET_ENV = ['CLAUDE_CODE_CHILD_SESSION'] as const;

/**
 * The full dangerous-rm waiver. A LOOSENING: it is set only when the `dangerousRmWaiver` setting
 * (`config/harness-claude-code.yaml`, default off, held for the owner when an agent turns it on) is true AND the ferret
 * runs in bypass mode, where the owner has already waived permission prompts. Without it a dangerous `rm` is always
 * denied (owner ruling 2026-11-15).
 *
 * All three variables belong together. Claude Code 2.1.317 treats the last two as SKIPS of the dangerous-rm check, not
 * answers to its prompt: on a mounted drive the "Dangerous rm operation detected … requires explicit approval" check
 * does not run, and inside `bash -c` / `sh -c` no check runs at all.
 *
 * - `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS`: the full waiver.
 * - `CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT`: no rm check for `rm` inside `bash -c` / `sh -c`.
 * - `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT`: no rm check for a path on a mounted drive.
 */
export const CLAUDE_RM_WAIVER_ENV = {
  CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1',
  CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT: '1',
  CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT: '1',
} as const;

/** Whether a launch sets {@link CLAUDE_RM_WAIVER_ENV} (all three variables): the setting on and bypass mode, never either alone. */
export const rmWaiverApplies = (dangerousRmWaiver: boolean, permissionMode: HarnessConfig['permissionMode']): boolean =>
  dangerousRmWaiver && permissionMode === 'skip';

/**
 * Fixed settings override item settings; the question hook and the compaction hooks (`./compaction.ts`) are ONLY in the
 * separate flag overlay. They are part of the `fixed-layer` fingerprint, so a ferret launched before them reads as
 * Restart-needed.
 */
export function fixedLayer(permissionMode: HarnessConfig['permissionMode'], cwd: string) {
  const skip = permissionMode === 'skip';
  const settings = {
    permissions: { defaultMode: skip ? 'bypassPermissions' : 'auto' },
    remoteControlAtStartup: false,
    ...(skip ? { skipDangerousModePermissionPrompt: true } : { skipAutoPermissionPrompt: true }),
  };
  return {
    settings,
    overlay: { ...settings, hooks: { ...CLAUDE_QUESTION_HOOKS, ...CLAUDE_COMPACTION_HOOKS } },
    claudeJson: {
      hasCompletedOnboarding: true,
      hasCompletedClaudeInChromeOnboarding: true,
      ...CLAUDE_PROMPTS_SEEN,
      projects: { [cwd]: { hasTrustDialogAccepted: true } },
    },
  };
}
