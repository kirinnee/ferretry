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
