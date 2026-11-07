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
      ...CLAUDE_PROMPTS_SEEN,
      projects: { [cwd]: { hasTrustDialogAccepted: true } },
    },
  };
}
