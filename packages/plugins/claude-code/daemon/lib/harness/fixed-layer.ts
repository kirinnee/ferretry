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

const REWAKE_FOLDER_ENV = 'FY_REWAKE_DIR';

/**
 * The listener the `Stop` hook runs (`asyncRewake`): it waits in the background after a turn ends and, when Ferretry leaves a
 * message in the folder `FY_REWAKE_DIR` names, hands it to the idle agent by exiting 2 with the message on stderr — Claude Code
 * starts a new turn on that text (measured on 2.1.317). POSIX `sh` and nothing else: no bun, no node, no network, and the
 * message text is printed nowhere but that one stderr.
 *
 * - No `FY_REWAKE_DIR` (a person's own terminal, an older daemon): it exits 0 at once and changes nothing.
 * - It writes its own token to `armed`; a NEWER listener replaces the token, and the older one sees it is no longer its own and
 *   exits 0, so re-arming at every Stop never doubles a delivery.
 * - Every second it touches `armed` (the heartbeat the daemon reads by modification time) and claims the OLDEST `*.md` by an
 *   atomic `mv` into `taken/`: one message per wake, the next Stop re-arms and takes the next.
 * - stdin is drained in the background so Claude never writes into a closed pipe.
 */
export const CLAUDE_REWAKE_HOOK_COMMAND = [
  'cat > /dev/null 2>&1 &',
  `d="$${REWAKE_FOLDER_ENV}"`,
  '[ -n "$d" ] && [ -d "$d" ] || exit 0',
  'umask 077',
  'mkdir -p "$d/taken" 2>/dev/null',
  'me="$$-$(date +%s)"',
  'printf %s "$me" > "$d/armed.$$.tmp" 2>/dev/null && mv -f "$d/armed.$$.tmp" "$d/armed" 2>/dev/null || exit 0',
  'while :; do',
  '  [ "$(cat "$d/armed" 2>/dev/null)" = "$me" ] || exit 0',
  '  touch "$d/armed" 2>/dev/null',
  '  for f in "$d"/*.md; do',
  '    [ -f "$f" ] || break',
  '    t="$d/taken/${f##*/}"',
  '    if mv "$f" "$t" 2>/dev/null; then cat "$t" >&2; exit 2; fi',
  '  done',
  '  sleep 1',
  'done',
].join('\n');

/**
 * How long Claude Code lets the listener run before killing it silently. Without a timeout it is killed before ~660 s and no
 * wake ever happens (measured), so the listener is given a day and re-armed at every Stop.
 */
export const CLAUDE_REWAKE_TIMEOUT_SECONDS = 86_400;

/** The overlay's `Stop` hook. Added beside the question hook, which it leaves as it was. */
export const CLAUDE_REWAKE_HOOKS = {
  Stop: [
    {
      hooks: [
        {
          type: 'command',
          command: CLAUDE_REWAKE_HOOK_COMMAND,
          asyncRewake: true,
          timeout: CLAUDE_REWAKE_TIMEOUT_SECONDS,
        },
      ],
    },
  ],
};

/**
 * `.claude.json` keys set ONLY when absent or `null` (today's `SEED_FILTER`): `claudeInChromeDefaultEnabled` is the
 * gate for Claude's browser prompt, and a home where somebody chose `true` must not be silently turned off.
 */
export const CLAUDE_JSON_DEFAULTS = { claudeInChromeDefaultEnabled: false } as const;

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
    overlay: { ...settings, hooks: { ...CLAUDE_QUESTION_HOOKS, ...CLAUDE_REWAKE_HOOKS } },
    claudeJson: {
      hasCompletedOnboarding: true,
      hasCompletedClaudeInChromeOnboarding: true,
      ...CLAUDE_PROMPTS_SEEN,
      projects: { [cwd]: { hasTrustDialogAccepted: true } },
    },
  };
}
