/**
 * What `adversarial-bound.test.ts` (unit: the hostile shapes at a small size, every answer checked) and
 * `tests/perf/host-config/adversarial-bound.test.ts` (perf: the shapes at the size cap, every door timed) share. This
 * file reads no clock.
 */
import { z } from 'zod';
import { AgentConfigCallSchema, type AgentConfigCall } from '../../../contract/agent-config.ts';
import { defineConfig } from '../../../contract/index.ts';
import { agentConfig } from '../../../host/config/agent.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import type { HostFs } from '../../../host/state/host-fs.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { mcpDef } from './masked-support.ts';
import { captureLog, HOME, manualClock } from './support.ts';

export const VOICE = `${HOME}/config/voice.yaml`;

/** A file the agent may name, taking any `note` so a valid hostile text is also put in effect (and read back). */
export const voiceDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10), note: z.unknown().optional() }),
  axis: 'configure',
  loosens: () => [],
});

export const ferretStanding = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };

export function world(fs: HostFs & { seed(path: string, data: string): void } = createMemoryHostFs()) {
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

export const call = (body: Record<string, unknown>): AgentConfigCall => AgentConfigCallSchema.parse(body);

/** A world holding the last good file, loaded: what every sample starts from. */
export async function prepared(): Promise<ReturnType<typeof world>> {
  const fresh = world();
  fresh.fs.seed(VOICE, 'limit: 7\n');
  await fresh.files.reload();
  return fresh;
}

/** A world of the `mcp` file kind, loaded. */
export async function mcpWorld() {
  const files = createConfigFiles({
    home: HOME,
    fs: createMemoryHostFs(),
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'mcp', def: mcpDef }],
  });
  const agent = agentConfig({
    writer: () => files.writer(),
    control: () => ({ allows: async () => true }),
    status: () => files.status(),
    home: HOME,
    binary: 'fy',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  await files.reload();
  return agent;
}

/** What a word of a command line is made of when somebody means harm: each repeated to fill a value of the cap. */
export const UNITS: readonly (readonly [label: string, unit: string])[] = [
  ['blanks', ' '],
  ['equals signs', '='],
  ['colons', ':'],
  ['dollar-brace openers', '${'],
  ['secret-pointer openers', '${secret:'],
  ['glued flags', '--token='],
  ['nested secret-named keys', 'API_KEY='],
  ['header keys', 'Authorization: '],
  ['URL userinfo', 'a://u:'],
  ['at signs', '@'],
  ['dashes', '-'],
  ['separators', '`,;'],
  ['flags and blanks', '--k '],
  ['pointer then key', '${secret:X} KEY='],
];

/** The same value as one scalar, as many list items, and as list items made of words, filled to about `size` bytes. */
export function wordShapes(unit: string, size: number): readonly (readonly [string, string])[] {
  const fillTo = (u: string): string => u.repeat(Math.floor((size - 64) / u.length));
  return [
    ['one scalar', `note: "${fillTo(unit)}"\n`],
    [
      'many list items',
      `args:\n${Array.from({ length: Math.floor((size - 64) / 40) }, () => `  - '${unit.repeat(Math.max(1, Math.floor(30 / unit.length)))}'\n`).join('')}`,
    ],
    ['one long list item of words', `args:\n  - '${fillTo(`${unit} `)}'\n`],
  ];
}
