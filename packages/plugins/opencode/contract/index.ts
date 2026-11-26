import { defineConfig, defineState, type Loosens } from '@ferretry/kernel/contract';
import { z } from 'zod';

export const OPENCODE = 'opencode';
export const HarnessConfigSchema = z.strictObject({
  binary: z.string().min(1).optional(),
  permissionMode: z.enum(['auto', 'skip']).default('skip'),
});
export type HarnessConfig = z.output<typeof HarnessConfigSchema>;
const loosens: Loosens<HarnessConfig> = (before, after) => [
  ...(before?.binary === after?.binary ? [] : ['agents now launch a different OpenCode program']),
  ...(before?.permissionMode === 'auto' && (after?.permissionMode ?? 'skip') === 'skip'
    ? ['agents now skip OpenCode permission prompts']
    : []),
];
export const OPENCODE_CONFIG = defineConfig({
  file: 'harness-opencode.yaml',
  schema: HarnessConfigSchema,
  axis: 'configure',
  loosens,
});
export const OPENCODE_HOMES = defineState({ name: 'agentHomes', path: 'agent-homes/*', store: 'opaque', format: 1 });
export const OPENCODE_SESSIONS = defineState({
  name: 'sessions',
  path: 'sessions/*.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ format: z.literal(1), session: z.string().regex(/^ses_[A-Za-z0-9_-]{1,160}$/u) }),
});
