import type { HarnessConfig } from '../../../contract/index.ts';

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
export const CLAUDE_JSON_DEFAULTS = { claudeInChromeDefaultEnabled: false } as const;

/**
 * What a ferret's home pre-answers so that no screen of the harness's own stops it (docs/harness-dialogs.md).
 *
 * - `DISABLE_AUTOUPDATER=1` (the variable v4's harness probe sets, here in the launch's process environment — never in
 *   the `--settings` overlay, which carries no env so a project's own wins): no "update available / installing"
 *   notice or self-update in a ferret's pane. Updates are Ferretry's to apply.
 * - `projects[<cwd>].hasTrustDialogAccepted`: the "Do you trust this folder?" screen, for the ferret's OWN working
 *   folder and no other (not a parent, not `*`). It lets that folder's `.claude/settings` and hooks run.
 * - `projects[<cwd>].enableAllProjectMcpServers`: the "New MCP server found in this project" approval, for the
 *   servers of THAT folder's `.mcp.json` only (the key lives in the project's own entry, so no other folder is
 *   touched). It lets those servers start unasked; a name in `disabledMcpjsonServers` still wins over it.
 */
export const CLAUDE_HOME_ENV = { DISABLE_AUTOUPDATER: '1' } as const;

/** Fixed settings override item settings; the question hook is ONLY in the separate flag overlay. */
export function fixedLayer(permissionMode: HarnessConfig['permissionMode'], cwd: string) {
  const skip = permissionMode === 'skip';
  const settings = {
    permissions: { defaultMode: skip ? 'bypassPermissions' : 'auto' },
    remoteControlAtStartup: false,
    ...(skip ? { skipDangerousModePermissionPrompt: true } : { skipAutoPermissionPrompt: true }),
  };
  return {
    settings,
    overlay: { ...settings, hooks: CLAUDE_QUESTION_HOOKS },
    claudeJson: {
      hasCompletedOnboarding: true,
      hasCompletedClaudeInChromeOnboarding: true,
      ...CLAUDE_PROMPTS_SEEN,
      projects: { [cwd]: { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true } },
    },
  };
}
