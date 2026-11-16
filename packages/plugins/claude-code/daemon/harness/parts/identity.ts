import type { ClaudeCore, Serves } from './core.ts';

export const identityPart = (_core: ClaudeCore): Serves<'accepts' | 'key' | 'turnStop'> => ({
  key: 'claude-code' as const,
  /** Claude spends an Anthropic sign-in, an API key, or a proxy or endpoint that speaks the Anthropic API. */
  accepts: ['anthropic', 'api-key', 'proxy', 'endpoint'] as const,
  /**
   * Today's stop key, harmless at an idle prompt (today's `STOP_KEY_SAFE_WHEN_IDLE`): at an interactive pane it clears a
   * half-typed composer or closes a menu, which is what "stop" means to the person pressing it.
   */
  turnStop: { key: 'Escape', safeWhenIdle: true } as const,
});
