/**
 * Gate: the admin and warden tokens and the audit log → `state/gate/` (`packages/core/gate/contract`: `admin-token`,
 * `warden-token` (`store: 'secret'`, `0600`), `audit.jsonl`).
 *
 * - `api-token` / `api-warden-token` (home root) → `admin-token` / `warden-token`, moved byte for byte and NEVER OPENED
 *   (`moveSealed`), then set to the declared `0600`. v5 keeps today's encoding: the CLI reads the file as raw text and
 *   trims it (`packages/cli/src/adapters/daemon/token-file.ts` `readAdminToken`), as v4's did, so every script and
 *   agent holding today's token keeps working.
 * - The four v4 audit files → ONE `audit.jsonl`, every record parsed by v5's `AuditRecordSchema` (names and ids only),
 *   ordered by time: v4's record field for field, plus `format: 1`; the four kinds v5 renamed take their new name
 *   (`src/v4/gate.ts` `V4_AUDIT_RENAMES`). v5 keeps the "kept" kinds by kind (`AUDIT_KEPT_KINDS`, the same list as
 *   v4's), so the two v4 stores need no second file.
 * - `grant-audit.jsonl` / `security-audit.jsonl` are NOT Gate's: v5 Access declares `grant-audit.jsonl` and writes both
 *   journals into it (`packages/plugins/access/daemon/runtime.ts`), so the Access step carries them line for line.
 *   v4's route-level `grants.changed` / `security.changed` records are in `audit.jsonl` already and carry here.
 * A line v4 itself could not read is skipped and counted, as v4's reader counted it; a record v5 refuses is counted too.
 */
import {
  AdminTokenFile,
  AUDIT_KIND_NAMES,
  AuditLogFile,
  type AuditRecord,
  AuditRecordSchema,
  WardenTokenFile,
} from '@ferretry/core-gate/contract';
import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeptItem, StepReport } from '../report.ts';
import { moveSealed } from '../sealed.ts';
import { failureNote, readV4Lines, V4InputError } from '../v4/documents.ts';
import { jsonLine, V4_ADMIN_TOKEN, V4_AUDIT_FILES, V4_WARDEN_TOKEN, v5AuditKind } from '../v4/gate.ts';
import type { Step } from './index.ts';

const V5_DIR = 'state/gate';
export const V5_ADMIN_TOKEN = join(V5_DIR, AdminTokenFile.path);
export const V5_WARDEN_TOKEN = join(V5_DIR, WardenTokenFile.path);
export const V5_AUDIT = join(V5_DIR, AuditLogFile.path);

/** One secret token file at the v4 home root, moved unopened into Gate's folder, `0600`. */
async function moveToken(
  ctx: Parameters<Step['run']>[0],
  from: string,
  to: string,
): Promise<{ file: string; bytes: number } | undefined> {
  const source = join(ctx.v4.home, from);
  const facts = await lstat(source).catch(() => undefined);
  if (facts === undefined) return undefined;
  if (!facts.isFile())
    throw new V4InputError(`${from}: is not a regular file (a token is never followed through a link)`);
  if (ctx.dryRun) return { file: to, bytes: facts.size };
  const moved = await moveSealed(source, ctx.v5.resolve(to));
  await chmod(moved.to, 0o600);
  return { file: to, bytes: moved.bytes };
}

export const gateStep: Step = {
  id: 'gate',
  title: 'Gate (admin and warden tokens moved unopened; the audit log)',
  owner: ['core-gate'],
  reads: [...V4_AUDIT_FILES],
  sealed: [V4_ADMIN_TOKEN, V4_WARDEN_TOKEN],
  notCarried: [
    {
      what: 'an audit line v4 could not read (torn, hand-edited or of an unknown event)',
      why: 'v4 counted it as unreadable and never showed it; skipped and counted, never quoted',
    },
    {
      what: 'the split between v4’s general and kept audit stores',
      why: 'v5 keeps one audit.jsonl and knows the kept records by kind (AUDIT_KEPT_KINDS, the same list as v4’s)',
    },
    {
      what: 'state/operator-password.json, the daemon-wide grants and security settings',
      why: 'not Gate state: grants and security settings are gate.yaml configuration, written by the Daemon settings step; the operator password was retired by v4 4.291.5 and has no v5 file',
    },
  ],
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried };
    const home = ctx.v4.home;
    try {
      const notes: string[] = ctx.dryRun ? ['dry run: nothing written'] : [];
      const kinds = new Set<string>(AUDIT_KIND_NAMES);
      const records: { record: AuditRecord; order: number }[] = [];
      let unreadable = 0;
      let refused = 0;
      let present = false;
      const keep = (candidate: unknown): void => {
        const parsed = AuditRecordSchema.safeParse(candidate);
        if (parsed.success && kinds.has(parsed.data.event))
          records.push({ record: parsed.data, order: records.length });
        else refused++;
      };

      for (const file of V4_AUDIT_FILES) {
        const found = await readV4Lines(home, file);
        if (found === undefined) continue;
        present = true;
        for (const line of found) {
          const value = jsonLine(line);
          const event = v5AuditKind(value?.event);
          if (value === undefined || event === undefined || 'format' in value) unreadable++;
          else keep({ format: 1, ...value, event });
        }
      }

      // Oldest first, as an append-only log reads; equal instants keep the order they were met in.
      records.sort((a, b) => Date.parse(a.record.at) - Date.parse(b.record.at) || a.order - b.order);
      if (present)
        await ctx.v5.jsonl(
          { path: V5_AUDIT, format: AuditLogFile.format, schema: AuditRecordSchema, mode: 0o600 },
          records.map(entry => entry.record),
        );
      if (unreadable > 0) notes.push(`${String(unreadable)} unreadable audit line(s) skipped, as v4 skipped them`);
      if (refused > 0) notes.push(`${String(refused)} audit record(s) v5 refuses skipped`);

      const sealed: { file: string; bytes: number }[] = [];
      for (const [from, to] of [
        [V4_ADMIN_TOKEN, V5_ADMIN_TOKEN],
        [V4_WARDEN_TOKEN, V5_WARDEN_TOKEN],
      ] as const) {
        const moved = await moveToken(ctx, from, to);
        if (moved !== undefined) sealed.push(moved);
        else notes.push(`no ${from} in the v4 home: nothing to move`);
      }

      const kept: KeptItem[] = [
        { what: 'audit records', count: records.length },
        { what: 'tokens (moved unopened)', count: sealed.length },
      ];
      return { ...base, status: 'converted', ...(notes.length > 0 ? { note: notes.join('; ') } : {}), kept, sealed };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note: failureNote(error, 'cannot convert the audit log or move the tokens'),
        kept: [],
        sealed: [],
      };
    }
  },
};
