import type { SttEnhancementResult } from '@ferretry/protocol';

/** The cleaned-up text, with the provider that produced it. */
export function renderEnhancement(result: SttEnhancementResult): string {
  return [result.text, `— ${result.provider}/${result.model} in ${Math.round(result.latencyMs)}ms`].join('\n');
}
