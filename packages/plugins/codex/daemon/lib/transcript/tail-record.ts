import type { HarnessTailRecord } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import type { TranscriptEvent } from './types.ts';

/** The most of a usage-limit sentence a tail record carries. */
const NOTICE_MAX = 200;

/**
 * One parsed rollout event as the record the turn watch and the live readout read (`HarnessTailRecord`): kinds, roles,
 * instants and counts. NO text leaves this function except the first sentence of a usage-limit error, cut short; the
 * caller masks that sentence (a `notice`) before it goes anywhere. Events that say nothing about a turn (settings,
 * attachments) are dropped.
 */
export function tailRecordOf(event: TranscriptEvent): HarnessTailRecord | undefined {
  const at = event.timestamp === undefined ? {} : { at: event.timestamp as Instant };
  switch (event.kind) {
    case 'message':
      return {
        kind: 'message',
        role: event.role === 'tool' ? 'system' : event.role,
        ...at,
        ...(event.inputSource === undefined ? {} : { inputSource: event.inputSource }),
      };
    case 'reasoning':
    case 'tool-call':
    case 'tool-result':
      return { kind: 'work', ...at };
    case 'turn':
      return { kind: 'turn', state: event.state, ...at };
    case 'usage':
      return {
        kind: 'usage',
        ...at,
        ...(event.messageId === undefined ? {} : { call: event.messageId }),
        ...(event.usage.inputTokens === undefined ? {} : { inputTokens: event.usage.inputTokens }),
        ...(event.usage.outputTokens === undefined ? {} : { outputTokens: event.usage.outputTokens }),
        ...(event.usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: event.usage.cachedInputTokens }),
        ...(event.usage.cacheCreationInputTokens === undefined
          ? {}
          : { cacheCreationInputTokens: event.usage.cacheCreationInputTokens }),
        ...(event.usage.contextTokens === undefined ? {} : { contextTokens: event.usage.contextTokens }),
      };
    case 'compaction':
      return {
        kind: 'compaction',
        ...at,
        ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
        ...(event.tokensBefore === undefined ? {} : { tokensBefore: event.tokensBefore }),
        ...(event.tokensAfter === undefined ? {} : { tokensAfter: event.tokensAfter }),
      };
    case 'error': {
      const notice = event.error.message.split('\n')[0]?.trim().slice(0, NOTICE_MAX);
      return {
        kind: 'error',
        ...at,
        ...(event.error.code === undefined ? {} : { code: event.error.code }),
        ...(notice === undefined || notice === '' ? {} : { notice }),
      };
    }
    default:
      return undefined;
  }
}
