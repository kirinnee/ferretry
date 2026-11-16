/** Narrow readers for the v4 fields this conversion consumes. Never open environment.json. */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  FerretProjectIdSchema,
  SessionProvenanceSchema,
  SessionTransferEdgeSchema,
  TranscriptProvenanceSchema,
} from '@ferretry/core-ferrets/contract';

export const V4Id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const Instant = z.iso.datetime({ offset: true });

export const Config = z.object({
  id: V4Id,
  name: z.string().min(1),
  /** The callsign (`:arleen`); `name` is the free-form title. */
  teammate: z.string().optional(),
  parent: V4Id.optional(),
  agent: z.string().min(1),
  harness: z.enum(['claude', 'codex']),
  cwd: z.string().min(1),
  tmuxSession: z.string().min(1).optional(),
  createdAt: Instant,
  updatedAt: Instant,
  transcript: TranscriptProvenanceSchema.optional(),
  provenance: SessionProvenanceSchema.optional(),
  transferredFrom: SessionTransferEdgeSchema.optional(),
  projectId: FerretProjectIdSchema.optional(),
  sessionCapabilityHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  credentialRevoked: z.literal(true).optional(),
});
export type V4Config = z.infer<typeof Config>;

export const RuntimeIds = z
  .object({
    version: z.literal(1),
    runtimes: z
      .record(
        z.string(),
        z.object({
          id: z.uuid(),
          formerNames: z.array(z.string().min(1)).default([]),
          home: z.string().min(1).optional(),
        }),
      )
      .default({}),
  })
  .refine(value => {
    const claims = new Set<string>();
    const ids = new Set<string>();
    for (const [name, entry] of Object.entries(value.runtimes)) {
      if (ids.has(entry.id)) return false;
      ids.add(entry.id);
      for (const claim of [name, ...entry.formerNames]) {
        if (claims.has(claim)) return false;
        claims.add(claim);
      }
    }
    return true;
  });

export async function runtimeIds(fleet: string) {
  const directory = await info(fleet);
  if (directory !== undefined && !directory.isDirectory()) throw new Error('invalid v4 fleet folder');
  return await json(join(fleet, 'ids.json'), RuntimeIds);
}

export const State = z.object({
  id: V4Id,
  status: z.enum([
    'created',
    'starting',
    'running',
    'thinking',
    'tool_running',
    'awaiting_question',
    'awaiting_user',
    'interrupted',
    'rate_limited',
    'retrying',
    'kill_failed',
    'waiting',
    'completed',
    'failed',
    'stalled',
    'stopped',
  ]),
  startedAt: Instant.optional(),
  finishedAt: Instant.optional(),
  lastActivityAt: Instant.optional(),
});

export const Pane = z.object({
  daemonId: z.string().min(1),
  sessionId: V4Id,
  tmuxSession: z.string().min(1),
  paneId: z.string().regex(/^%\d+$/u),
  pid: z.number().int().positive(),
  processStartTicks: z.number().int().nonnegative(),
});

export async function info(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('cannot inspect v4 input');
  }
}

/** No links, including intermediate directories: never traverse into a credential area. */
export async function directories(path: string): Promise<string[]> {
  const source = await info(path);
  if (source === undefined) return [];
  if (!source.isDirectory()) throw new Error('v4 folder is not a directory');
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.some(entry => entry.isSymbolicLink())) throw new Error('v4 folder contains a link');
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

export async function json<Shape>(path: string, schema: z.ZodType<Shape>): Promise<Shape | undefined> {
  const source = await info(path);
  if (source === undefined) return undefined;
  if (!source.isFile()) throw new Error('v4 document is not a regular file');
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw new Error('invalid v4 document');
  }
}

export async function configs(sessions: string): Promise<V4Config[]> {
  const state = await info(dirname(sessions));
  if (state !== undefined && !state.isDirectory()) throw new Error('invalid v4 state folder');
  const records: V4Config[] = [];
  for (const id of await directories(sessions)) {
    if (!V4Id.safeParse(id).success) throw new Error('invalid v4 session folder');
    const config = await json(join(sessions, id, 'config.json'), Config);
    if (config === undefined) continue;
    if (config.id !== id) throw new Error('v4 session identity mismatch');
    records.push(config);
  }
  return records;
}

export function runtimeName(agent: string): string {
  return basename(agent);
}

export async function paneFor(sessions: string, config: V4Config) {
  const pane = await json(join(sessions, config.id, 'terminal-pane.json'), Pane);
  if (
    pane !== undefined &&
    (pane.sessionId !== config.id || (config.tmuxSession !== undefined && pane.tmuxSession !== config.tmuxSession))
  )
    throw new Error('v4 terminal identity mismatch');
  return pane;
}
