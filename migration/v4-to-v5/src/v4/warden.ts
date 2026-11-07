/**
 * v4 Warden files (4.291.5), `state/warden/` (`packages/daemon/src/lib/warden/paths.ts`). A LOCAL copy on purpose:
 * the product has no v4 reader.
 *
 * - `state.json`: one JSON object with NO version. v4 reads it raw and salvages it section by section
 *   (`lib/warden/state.ts` `parseWardenRuntimeState`), so only the sections this conversion changes are typed here.
 * - `reports/<ISO>[-<target>].md` and `<same>.md.meta.json`: an investigation's report and its provenance.
 * - `jev-checks/<UTC YYYY-MM-DD>.jsonl`: one JSON line per guard-model check, appended (a torn line is skipped).
 * - `auto-migrate.json`: the login-move ledger (`{sessions: {<sid>: {moves, asked?, held?}}}`).
 */
import { z } from 'zod';

export const V4_WARDEN_DIR = 'state/warden';
export const V4_WARDEN_STATE = 'state/warden/state.json';
export const V4_WARDEN_REPORTS = 'state/warden/reports';
export const V4_WARDEN_JEV_CHECKS = 'state/warden/jev-checks';

/** `lib/warden/jev-checks.ts` `jevCheckFileName`: `<day>.jsonl`. */
export const V4_JEV_CHECK_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;

const Instant = z.iso.datetime({ offset: true });

/** `lib/warden/state.ts` `BlessingSchema`; the store is keyed by session id, one blessing each. */
export const V4Blessing = z.object({
  sessionId: z.string().min(1),
  kinds: z.array(z.string()),
  status: z.string(),
  blessedAt: Instant,
  expiresAt: Instant,
  wardenId: z.string().min(1).optional(),
  /** Absent means a warden judged it (`lib/warden/bless.ts`). */
  by: z.enum(['jev', 'warden', 'owner']).optional(),
  streak: z.number().int().min(1).optional(),
  untilChange: z.literal(true).optional(),
});
export type V4Blessing = z.infer<typeof V4Blessing>;
