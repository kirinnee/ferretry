import { CODEX_FACTS } from '../../lib/facts.ts';
import type { HarnessPart } from './context.ts';

/** Who this harness is, what it accepts as a login, and how a turn is stopped. */
export const identityPart: HarnessPart<'key' | 'facts' | 'turnStop' | 'accepts'> = () => {
  return {
    key: 'codex',
    facts: CODEX_FACTS,
    // Today's stop key. NOT safe when idle: at an idle Codex prompt a stop key is one of the ways the TUI quits, so an
    // interrupt presses it only while the pane shows active work (`shouldPressStopKey`).
    turnStop: { key: 'Escape', safeWhenIdle: false },

    // The ChatGPT sign-in, a plain API key, and the gateways Codex can be pointed at.
    accepts: ['openai', 'api-key', 'proxy', 'endpoint'],
  };
};
