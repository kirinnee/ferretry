import text from './default-instructions.txt' with { type: 'text' };

/**
 * The system instructions Codex ships for a model its catalog has no entry for, as measured on Codex 0.145.0 and
 * 0.156.1. A model catalog file for a third-party provider needs a `base_instructions` for every model, and borrowing a
 * bundled OpenAI entry would hand a foreign model another vendor's prompt. Refreshed from the installed Codex by the
 * `refresh-codex-default-instructions` repo script.
 */
export const CODEX_DEFAULT_INSTRUCTIONS: string = text;
