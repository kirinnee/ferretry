import {
  ArchiveDocumentSchema,
  ArchiveFile,
  FerretHistoryEventSchema,
  FerretHistoryFiles,
  ForkFiles,
  ManagedWorktreeDocumentSchema,
  NameClaimSchema,
  NamesDocumentSchema,
  NamesFile,
  SessionForkReceiptSchema,
  WorktreesFile,
} from '@ferretry/core-ferrets/contract';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { KeptItem } from '../report.ts';
import { info, json, type V4Config } from '../v4/ferrets.ts';
import type { StepContext } from './index.ts';

// These contracts describe the body; the kernel's declared format stamp surrounds it on disk.
const Names = NamesDocumentSchema.extend({ format: z.literal(NamesFile.format) });
const Archive = ArchiveDocumentSchema.extend({ format: z.literal(ArchiveFile.format) });
const Worktrees = ManagedWorktreeDocumentSchema.extend({ format: z.literal(WorktreesFile.format) });
const Fork = SessionForkReceiptSchema.safeExtend({ format: z.literal(ForkFiles.format) });

/** v4's reader discarded this obsolete field before validating the frozen durable config. */
const V4Fork = z.preprocess(value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.plan !== 'object' || record.plan === null || Array.isArray(record.plan)) return value;
  const plan = record.plan as Record<string, unknown>;
  if (typeof plan.durable !== 'object' || plan.durable === null || Array.isArray(plan.durable)) return value;
  const { boardAccess: _removed, ...durable } = plan.durable as Record<string, unknown>;
  return { ...record, plan: { ...plan, durable } };
}, SessionForkReceiptSchema);

/** Validate the whole set before issuing a write; errors are redacted by the owning step. */
export async function prepareLedgers(ctx: StepContext, records: readonly V4Config[]) {
  const writes: (() => Promise<void>)[] = [];
  const kept: KeptItem[] = [];
  let historyCount = 0;
  for (const config of records) {
    const source = join(ctx.v4.sessions, config.id, 'events.jsonl');
    const metadata = await info(source);
    if (metadata === undefined) continue;
    if (!metadata.isFile()) throw new Error('invalid journal file');
    const text = await readFile(source, 'utf8');
    const lines = text === '' ? [] : text.replace(/\n$/u, '').split('\n');
    const events = lines.map(line => FerretHistoryEventSchema.parse(JSON.parse(line)));
    let sequence = 0;
    for (const event of events) {
      if (event.sessionId !== config.id || event.sequence <= sequence)
        throw new Error('invalid journal order or identity');
      sequence = event.sequence;
    }
    historyCount += events.length;
    writes.push(() =>
      ctx.v5.jsonl(
        {
          ...FerretHistoryFiles,
          path: join('state/ferrets', config.id, 'history.jsonl'),
          schema: FerretHistoryEventSchema,
        },
        events,
      ),
    );
  }
  kept.push({ what: 'journal events', count: historyCount });

  const claims = await json(join(ctx.v4.state, 'callsigns.json'), z.array(NameClaimSchema));
  if (claims !== undefined)
    writes.push(() =>
      ctx.v5.json({ ...NamesFile, path: join('state/ferrets', NamesFile.path), schema: Names }, { format: 1, claims }),
    );
  kept.push({ what: 'callsign claims', count: claims?.length ?? 0 });

  const archive = await json(ctx.v4.archivedSessions, ArchiveDocumentSchema.extend({ version: z.literal(1) }));
  if (archive !== undefined) {
    const document = Archive.parse({ format: 1, sessions: archive.sessions });
    writes.push(() =>
      ctx.v5.json({ ...ArchiveFile, path: join('state/ferrets', ArchiveFile.path), schema: Archive }, document),
    );
  }
  kept.push({ what: 'archive entries', count: Object.keys(archive?.sessions ?? {}).length });

  const registry = await json(
    join(ctx.v4.state, 'worktrees.json'),
    ManagedWorktreeDocumentSchema.extend({
      version: z.literal(1),
      intents: ManagedWorktreeDocumentSchema.shape.intents.default([]),
    }),
  );
  // The preview carries no worktree ownership: a clean-up there must never remove a worktree a live v4 ferret works in.
  if (registry !== undefined && ctx.preview !== true) {
    const document = Worktrees.parse({ format: 1, worktrees: registry.worktrees, intents: registry.intents });
    writes.push(() =>
      ctx.v5.json({ ...WorktreesFile, path: join('state/ferrets', WorktreesFile.path), schema: Worktrees }, document),
    );
  }
  kept.push(
    { what: 'managed worktrees', count: ctx.preview === true ? 0 : (registry?.worktrees.length ?? 0) },
    { what: 'worktree intents', count: ctx.preview === true ? 0 : (registry?.intents.length ?? 0) },
  );

  const forks = join(ctx.v4.state, 'forks');
  const directory = await info(forks);
  let forkCount = 0;
  if (directory !== undefined) {
    if (!directory.isDirectory()) throw new Error('invalid fork folder');
    for (const name of (await readdir(forks)).sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}\.json$/u.test(name)) throw new Error('invalid fork filename');
      const receipt = await json(join(forks, name), V4Fork);
      if (receipt === undefined || name !== `${receipt.planId}.json`) throw new Error('fork identity mismatch');
      const document = Fork.parse({ format: 1, ...receipt });
      writes.push(() => ctx.v5.json({ ...ForkFiles, path: join('state/ferrets/forks', name), schema: Fork }, document));
      forkCount++;
    }
  }
  kept.push({ what: 'fork receipts', count: forkCount });
  return {
    kept,
    /** Folders of the managed worktrees v4 lists (the preview swaps a ferret working in one of them). */
    worktreeFolders: (registry?.worktrees ?? []).map(record => record.path),
    async write() {
      for (const write of writes) await write();
    },
  };
}
