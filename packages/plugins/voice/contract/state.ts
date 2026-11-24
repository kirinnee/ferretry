import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * `state/voice/speedup-tests.json`: the last Test of each speed-up key, in one small document. It holds names, codes,
 * sentences and instants — never a key, and never a provider's reply. A document that is missing or unreadable reads as
 * "never tested": the worst a damaged ledger can do is make a working key ask to be tested again.
 */
export const SPEEDUP_TESTS_STATE = defineState({
  name: 'speedup-tests',
  path: 'speedup-tests.json',
  store: 'json',
  format: 1,
  schema: z.looseObject({ results: z.record(z.string(), z.unknown()) }),
  onDamaged: { narrower: 'every speed-up reads as never tested; the keys themselves are unaffected' },
});

/** `state/voice/models/`: the speech-model cache the daemon may hold for a device (dropped and rebuilt on a mismatch). */
export const MODELS_STATE = defineState({
  name: 'models',
  path: 'models/*',
  store: 'opaque',
  format: 1,
  onDamaged: { narrower: 'the model cache starts empty; devices keep their own copies' },
});

/**
 * `state/voice/reply-spend.json`: how many characters of spoken replies were sent to ElevenLabs on one machine-day, so the
 * daily cap holds across restarts. A count and a day, never a word. A document that is missing or unreadable reads as
 * "nothing spent today", which can only let one more day's worth through after damage, never lose a key.
 */
export const REPLY_SPEND_STATE = defineState({
  name: 'reply-spend',
  path: 'reply-spend.json',
  store: 'json',
  format: 1,
  schema: z.looseObject({ day: z.string(), chars: z.number() }),
  onDamaged: {
    narrower: 'today’s spoken-character count starts again from zero; the keys and settings are unaffected',
  },
});
