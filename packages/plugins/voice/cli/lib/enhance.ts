import {
  MAX_STT_DICTIONARY_ENTRIES,
  type SttEnhancementRequest,
  type SttEnhancementResult,
} from '../../contract/index.ts';

/** Flags that shape an enhancement. */
export interface EnhanceOptions {
  readonly model?: string | undefined;
  readonly term?: readonly string[] | undefined;
  readonly context?: string | undefined;
}

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim() ?? '';
  return text === '' ? undefined : text;
};

/**
 * The request `fy voice enhance` posts. Dictation itself runs in the browser; this only cleans dictated text up through
 * the configured enhancement provider.
 *
 * The wire carries at most `MAX_STT_DICTIONARY_ENTRIES` terms, and the schema refuses the WHOLE request when a
 * dictionary is longer. Keeping the first entries is what the contract asks of a client: one term too many costs that
 * term, never the correction.
 */
export function enhanceRequest(words: readonly string[], options: EnhanceOptions): SttEnhancementRequest {
  const text = words.join(' ').trim();
  if (text === '') throw new Error('enhance needs the text to clean up');
  const model = trimmed(options.model);
  const userContext = trimmed(options.context);
  const dictionary = (options.term ?? [])
    .map(term => term.trim())
    .filter(term => term !== '')
    .slice(0, MAX_STT_DICTIONARY_ENTRIES);
  return {
    text,
    provider: 'groq',
    ...(model === undefined ? {} : { model }),
    ...(userContext === undefined ? {} : { userContext }),
    ...(dictionary.length === 0 ? {} : { dictionary: dictionary.map(term => ({ term })) }),
  };
}

/** The cleaned-up text, with the provider that produced it. */
export function renderEnhancement(result: SttEnhancementResult): string {
  return [result.text, `— ${result.provider}/${result.model} in ${Math.round(result.latencyMs)}ms`].join('\n');
}
