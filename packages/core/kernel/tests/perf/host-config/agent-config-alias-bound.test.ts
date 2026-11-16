/**
 * The SPEED half of the alias block of `../../unit/host-config/agent-config.test.ts`: a file at the size limit is checked
 * in one pass, whatever its aliases do. The answers (refused, last good stays) are unit's, at a small size.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AGENT_CONFIG_TEXT_MAX_BYTES,
  AgentConfigCallSchema,
  type AgentConfigCall,
} from '../../../contract/agent-config.ts';
import { defineConfig } from '../../../contract/index.ts';
import { agentConfig } from '../../../host/config/agent.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { aliasShapes } from '../../unit/host-config/alias-shapes.ts';
import { captureLog, HOME, manualClock } from '../../unit/host-config/support.ts';

const UPDATES = `${HOME}/config/voice.yaml`;
const voiceDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({
    limit: z.number().int().default(10),
    note: z.string().optional(),
    apiKey: z.string().optional(),
  }),
  axis: 'configure',
  loosens: () => [],
});
const ferretStanding = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };
const call = (body: Record<string, unknown>): AgentConfigCall => AgentConfigCallSchema.parse(body);

function world() {
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'voice', def: voiceDef }],
  });
  const agent = agentConfig({
    writer: () => files.writer(),
    control: () => ({ allows: async () => true }),
    status: () => files.status(),
    home: HOME,
    binary: 'fy',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { fs, files, agent };
}

describe('a file at the size limit is checked in one pass, whatever its aliases do (R5 critical)', () => {
  /** A hard bound per call, far above one linear pass; the quadratic reads this guards took minutes at this size. */
  const BOUND_MS = 1500;
  for (const [label, text] of aliasShapes(AGENT_CONFIG_TEXT_MAX_BYTES)) {
    test(`T-0033 T-0034 ${label}: validate and write each answer in under ${BOUND_MS} ms`, async () => {
      const { agent, fs, files } = world();
      fs.seed(UPDATES, 'limit: 7\n');
      await files.reload();
      for (const tool of ['config.validate', 'config.write'] as const) {
        const started = performance.now();
        await agent.run(call({ tool, path: 'voice.yaml', text }), ferretStanding);
        expect(performance.now() - started).toBeLessThan(BOUND_MS);
      }
    });

    test(`T-0032 ${label}, hand-written: the reload answers in under ${BOUND_MS} ms`, async () => {
      const { fs, files } = world();
      fs.seed(UPDATES, 'limit: 7\n');
      await files.reload();
      fs.seed(UPDATES, text);
      const started = performance.now();
      await files.reload();
      expect(performance.now() - started).toBeLessThan(BOUND_MS);
    });
  }
});
