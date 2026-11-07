import { z } from 'zod';
import { defineState } from '../../../contract/index.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { createStatePort, type StatePortOptions } from '../../../host/state/state-port.ts';

export const HOME = '/home/fy';

export const Counter = z.strictObject({ count: z.number().int() });
export type CounterShape = z.infer<typeof Counter>;

export const counterFile = defineState({
  name: 'counter',
  path: 'counter.json',
  store: 'json',
  format: 2,
  schema: Counter,
});
export const requiredFile = defineState({
  name: 'required',
  path: 'required.json',
  store: 'json',
  format: 1,
  schema: Counter,
  required: true,
});
export const rulesFile = defineState({
  name: 'rules',
  path: 'sign-in-rules.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ rules: z.array(z.string()) }),
  onDamaged: { narrower: 'reads as zero rules' },
});
export const cardFile = defineState({ name: 'card', path: 'cards/*.json', store: 'json', format: 1, schema: Counter });
export const logFile = defineState({ name: 'log', path: 'log.jsonl', store: 'jsonl', format: 1, schema: Counter });
export const keyFile = defineState({ name: 'key', path: 'message-token.key', store: 'secret', format: 1 });
export const blobFile = defineState({ name: 'blob', path: 'blob.bin', store: 'opaque', format: 1 });

export const allFiles = [counterFile, requiredFile, rulesFile, cardFile, logFile, keyFile, blobFile] as const;

export function memoryStore(overrides: Partial<StatePortOptions> = {}) {
  const fs = createMemoryHostFs();
  const port = createStatePort({ home: HOME, pluginId: 'demo', files: allFiles, fs, ...overrides });
  return { fs, port, path: (relative: string) => `${HOME}/state/demo/${relative}` };
}
