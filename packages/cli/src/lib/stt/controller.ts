import { MAX_STT_DICTIONARY_ENTRIES, type SttEnhancementResult } from '@ferretry/protocol';
import type { ISttGateway, ISttOutput } from './ports.ts';
import { renderEnhancement } from './render.ts';

/** Options every dictation command accepts. */
export interface SttCommandOptions {
  readonly json?: boolean;
}

/** Flags that shape an enhancement. */
export interface SttEnhanceOptions extends SttCommandOptions {
  readonly model?: string;
  readonly term?: readonly string[];
  readonly context?: string;
}

/**
 * Drives `fy stt enhance`.
 *
 * Dictation itself runs in the browser; this group only cleans dictated text up through the
 * configured enhancement provider.
 */
export class SttController {
  constructor(
    private readonly gateway: ISttGateway,
    private readonly out: ISttOutput,
  ) {}

  async enhance(words: readonly string[], options: SttEnhanceOptions): Promise<void> {
    const text = words.join(' ').trim();
    if (text === '') throw new Error('enhance needs the text to clean up');
    const model = trimmed(options.model);
    const userContext = trimmed(options.context);
    // The wire carries at most `MAX_STT_DICTIONARY_ENTRIES` terms, and the schema refuses the WHOLE
    // request when a dictionary is longer. Keeping the first entries is what the contract asks of a
    // client: one term too many costs that term, never the correction.
    const dictionary = (options.term ?? [])
      .map(term => term.trim())
      .filter(term => term !== '')
      .slice(0, MAX_STT_DICTIONARY_ENTRIES);
    const result = await this.gateway.enhance({
      text,
      provider: 'groq',
      ...(model === undefined ? {} : { model }),
      ...(userContext === undefined ? {} : { userContext }),
      ...(dictionary.length === 0 ? {} : { dictionary: dictionary.map(term => ({ term })) }),
    });
    this.#report(result, options, () => renderEnhancement(result));
  }

  #report(payload: SttEnhancementResult, options: SttCommandOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(payload, null, 2) : human());
  }
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim() ?? '';
  return text === '' ? undefined : text;
}
