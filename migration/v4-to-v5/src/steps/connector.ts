/**
 * The Claude connector: v4's `daemon.json` `connector` block and `state/connector/` → v5's `config/connector.yaml` and
 * `state/connector/` (`packages/plugins/connector/contract`). With the same `publicUrl` the issuer and the audience do
 * not change, and every stored token is a digest of a value Claude already holds, so Claude STAYS SIGNED IN across the move.
 *
 * - **config.** The `connector` block is checked with v5's own `ConnectorConfigSchema` (its rules are v4's, word for word)
 *   and written key for key, only the keys the owner wrote (`enabled`, `publicUrl`, `port`, `extraRedirectUris`). NEVER
 *   WIDER: a block v5 would refuse writes no file at all (the connector is off, as v4 read it) and the report names the key
 *   path, never a value. The step does not move the port: the owner's own `cloudflared` keeps pointing at `127.0.0.1:7461`.
 * - **state.** `connector.json` is read with a local copy of v4's schema (a file v4 would refuse fails the step; nothing
 *   is repaired) and written in v5's one shape: `version` becomes `format`, and every rotated-away refresh token is spelled
 *   as a full record. A bare digest, or a record written before the 30-day stamp existed, gets the stamp v4 would have given
 *   it on its next write (this run + 30 days). The first-rotation `retryable` marker (v4 PR 2550) is carried exactly where v4
 *   would have honoured it, which is where `rotatedAt` and `successors` are present too; anywhere else it is left off, so a
 *   reuse revokes the grant as v4 read it. v5's runtime reads ONLY this shape: there is no older reader in the product.
 * - **calls log.** `calls.1.jsonl` then `calls.jsonl` become one `calls.jsonl`, in order, each line re-stamped with the
 *   `format` v5's state port requires first (a line without it reads as damaged). Fields are untouched. A line that is not a
 *   JSON object is counted, never printed.
 * - **not carried.** Pending sign-ins and authorization codes (memory only in v4, minutes long): the person signs in again.
 * - **a preview** carries nothing: its tokens would authenticate against v4's address, and its listener would fight v4's.
 *
 * The report names counts and ids (`cg_…`), never a digest.
 */
import {
  CONNECTOR_CALLS,
  CONNECTOR_STATE,
  ConnectorConfigSchema,
  ConnectorStateFileSchema,
} from '@ferretry/plugin-connector/contract';
import type { ConnectorState } from '@ferretry/plugin-connector/contract';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Document } from 'yaml';
import { z } from 'zod';
import { keyPath } from '../key-path.ts';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import { YAML_OPTIONS } from '../v4/config.ts';
import {
  V4_CONNECTOR_CALLS,
  V4_CONNECTOR_CALLS_ROTATED,
  V4_CONNECTOR_STATE,
  V4ConnectorState,
  type V4UsedRefresh,
} from '../v4/connector.ts';
import { V4_DAEMON_JSON } from '../v4/daemon.ts';
import { failureNote, isRecord, readV4Json, readV4Lines, V4InputError } from '../v4/documents.ts';
import { CONFIG_TARGETS } from '../v5/targets.ts';
import { configPath } from '../v5/write.ts';
import type { Step } from './index.ts';

export const V5_CONNECTOR_STATE = join('state/connector', CONNECTOR_STATE.path);
export const V5_CONNECTOR_CALLS = join('state/connector', CONNECTOR_CALLS.path);

/** v4's stamp for a rotated-away refresh token that carried none (`LEGACY_USED_REFRESH_MS`): the refresh lifetime. */
const LEGACY_USED_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

const CONFIG_KEYS = ['enabled', 'publicUrl', 'port', 'extraRedirectUris'] as const;

const NOT_CARRIED: readonly NotCarried[] = [
  {
    what: 'pending Claude sign-ins and their authorization codes',
    why: 'memory only in v4 (minutes long): Claude signs in again if one was waiting at the move',
  },
];

/** A rotated-away refresh token in v5's one shape (see the file comment for what each rule keeps). */
function usedRefresh(used: V4UsedRefresh, now: number): ConnectorState['grants'][number]['usedRefresh'][number] {
  const expiresAt = used.expiresAt ?? now + LEGACY_USED_REFRESH_MS;
  const rotatedAt = used.rotatedAt ?? now;
  // v4 honoured a retry only for `retryable: true` with BOTH `rotatedAt` and `successors` present.
  const retryable = used.retryable === true && used.rotatedAt !== undefined && used.successors !== undefined;
  return {
    digest: used.digest,
    expiresAt,
    rotatedAt,
    ...(used.successors === undefined ? {} : { successors: used.successors }),
    ...(retryable ? { retryable: true as const } : {}),
  };
}

function convertState(v4: V4ConnectorState, now: number): ConnectorState {
  return ConnectorStateFileSchema.parse({
    format: CONNECTOR_STATE.format,
    clients: v4.clients,
    grants: v4.grants.map(grant => ({ ...grant, usedRefresh: grant.usedRefresh.map(used => usedRefresh(used, now)) })),
  });
}

/** The config text for a v4 block, or the sentences that say why none is written. Never a value. */
function convertConfig(
  block: unknown,
): { readonly text: string; readonly keys: number } | { readonly problems: string[] } {
  if (!isRecord(block)) return { problems: ['"connector" is not an object'] };
  const parsed = ConnectorConfigSchema.safeParse(block);
  if (!parsed.success)
    return {
      problems: parsed.error.issues.map(issue => {
        const keys = issue.code === 'unrecognized_keys' ? ` ${issue.keys.join(', ')}` : '';
        return `${keyPath(['connector', ...issue.path])} (${issue.code}${keys})`;
      }),
    };
  const document = new Document({}, YAML_OPTIONS);
  document.commentBefore =
    ' The Claude connector, converted from config/daemon.json "connector" (same keys, same meaning).';
  let keys = 0;
  for (const key of CONFIG_KEYS)
    if (block[key] !== undefined) {
      document.set(key, parsed.data[key]);
      keys++;
    }
  return { text: String(document), keys };
}

const CallLine = z.record(z.string(), z.unknown()).refine(line => !('format' in line));

export const connectorStep: Step = {
  id: 'connector',
  title: 'Claude connector (switch, address, approved apps and their sign-ins)',
  owner: ['plugin-connector'],
  reads: [V4_DAEMON_JSON, V4_CONNECTOR_STATE, V4_CONNECTOR_CALLS, V4_CONNECTOR_CALLS_ROTATED],
  sealed: [],
  notCarried: NOT_CARRIED,
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, sealed: [] };
    const home = ctx.v4.home;
    if (ctx.preview === true)
      return {
        ...base,
        status: 'converted',
        note: 'a preview carries no connector',
        kept: [],
        notCarried: [
          ...NOT_CARRIED,
          {
            what: 'the connector switch, address and sign-ins',
            why: 'a preview must not authenticate against, or listen where, the live v4 does; the real move carries them',
          },
        ],
      };
    const notCarried: NotCarried[] = [...NOT_CARRIED];
    const kept: KeptItem[] = [];
    const notes: string[] = ctx.dryRun ? ['dry run: nothing written'] : [];
    try {
      const now = (ctx.now ?? (() => new Date()))().getTime();

      // ── config ──
      const daemon = await readV4Json(home, join(home, V4_DAEMON_JSON));
      const block = isRecord(daemon) ? daemon.connector : undefined;
      if (block !== undefined) {
        const config = convertConfig(block);
        if ('problems' in config) {
          notes.push(`the connector block is not valid, so the connector is off (${config.problems.join(', ')})`);
          notCarried.push({
            what: `${V4_DAEMON_JSON} connector`,
            why: `v5 refuses it (${config.problems.join(', ')}): written nowhere, the connector stays off as v4 read it. Fix the keys named, then switch it on in the app`,
          });
        } else {
          await ctx.v5.config(CONFIG_TARGETS.CONNECTOR, undefined, config.text, [V4_DAEMON_JSON]);
          kept.push({ what: `${configPath(CONFIG_TARGETS.CONNECTOR)} keys (key for key)`, count: config.keys });
        }
      }

      // ── state ──
      const value = await readV4Json(home, join(home, V4_CONNECTOR_STATE));
      if (value !== undefined) {
        const v4 = V4ConnectorState.safeParse(value);
        if (!v4.success)
          throw new V4InputError(
            `${V4_CONNECTOR_STATE}: is not a document v4 reads (${v4.error.issues.map(issue => keyPath(issue.path)).join(', ')}); v4 refuses all connector access on it, so nothing is carried`,
          );
        const document = convertState(v4.data, now);
        await ctx.v5.json(
          { path: V5_CONNECTOR_STATE, format: CONNECTOR_STATE.format, schema: ConnectorStateFileSchema, mode: 0o600 },
          document,
        );
        const live = document.grants.filter(grant => grant.revokedAt === undefined);
        const named = (grants: typeof document.grants): string =>
          grants.length === 0 ? '' : ` (${grants.map(grant => grant.id).join(', ')})`;
        kept.push(
          { what: 'connector clients (secret digests kept)', count: document.clients.length },
          { what: `connector grants, live${named(live)}`, count: live.length },
          { what: 'connector grants, revoked', count: document.grants.length - live.length },
          {
            what: 'live access and refresh token digests',
            count: live.reduce((sum, grant) => sum + grant.access.length + grant.refresh.length, 0),
          },
          {
            what: 'rotated-away refresh digests (reuse still revokes)',
            count: document.grants.reduce((sum, grant) => sum + grant.usedRefresh.length, 0),
          },
        );
      }

      // ── calls log: the rotated file first, so the order is the order the calls happened ──
      const lines = [
        ...((await readV4Lines(home, V4_CONNECTOR_CALLS_ROTATED)) ?? []),
        ...((await readV4Lines(home, V4_CONNECTOR_CALLS)) ?? []),
      ];
      if (lines.length > 0) {
        const records: Record<string, unknown>[] = [];
        let unreadable = 0;
        for (const line of lines) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(line);
          } catch {
            decoded = undefined;
          }
          const record = CallLine.safeParse(decoded);
          if (record.success) records.push(record.data);
          else unreadable++;
        }
        await ctx.v5.jsonl(
          {
            path: V5_CONNECTOR_CALLS,
            format: CONNECTOR_CALLS.format,
            schema: z.record(z.string(), z.unknown()),
            mode: 0o600,
          },
          records,
        );
        kept.push({
          what: 'connector write-tool call records (calls.1.jsonl + calls.jsonl, in order)',
          count: records.length,
        });
        if (unreadable > 0)
          notCarried.push({
            what: 'calls-log lines that are not one JSON object',
            why: `${String(unreadable)} line(s) of ${V4_CONNECTOR_CALLS} / ${V4_CONNECTOR_CALLS_ROTATED} could not be re-stamped for v5 and were left behind in the v4 backup`,
          });
      }

      const present = await lstat(join(home, V4_CONNECTOR_STATE)).then(
        () => true,
        () => false,
      );
      if (kept.length === 0 && !present) notes.push('this home has no Claude connector');
      return {
        ...base,
        status: 'converted',
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        kept,
        notCarried,
      };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note: failureNote(error, 'cannot convert the Claude connector'),
        kept: [],
        notCarried,
      };
    }
  },
};
