import {
  type FerretEndCause,
  FerretFiles,
  FerretNameSchema,
  LoginNameSchema,
  FerretRecordSchema,
  FerretTokensFile,
  FerretTokensSchema,
  DAEMON_ORIGIN,
  RestartQueueEntrySchema,
  RestartsFile,
} from '@ferretry/core-ferrets/contract';
import { z } from 'zod';
import { isScalar } from 'yaml';
import { join } from 'node:path';
import type { NotCarried, StepReport } from '../report.ts';
import { CODEX_HELD_SENTENCE, heldReason, heldRuntimes, holdsCodex } from './preview-hold.ts';
import { previewFolder, rewriteTranscript } from '../v5/harness-paths.ts';
import { listV4Config, readV4Yaml } from '../v4/config.ts';
import { configs, json, paneFor, runtimeIds, runtimeName, State, type V4Config } from '../v4/ferrets.ts';
import type { Step, StepContext } from './index.ts';
import { type DetailsSource, prepareDetails } from './ferret-details.ts';
import { prepareLedgers } from './ferret-ledgers.ts';

/**
 * v5's `name` is what `:name` references: v4's callsign, `teammate`. v4's `name` is the free-form title (carried as
 * `details.json` `title`). A session older than callsigns has none: its title is used when it is a valid v5 name,
 * otherwise its id, so an odd title never fails the step.
 */
export const v5FerretName = (config: { id: string; name: string; teammate?: string }): string =>
  [config.teammate, config.name].find(name => name !== undefined && FerretNameSchema.safeParse(name).success) ??
  config.id;

/**
 * The registry state of a ferret v4 did not see finish. One still in its pane (`attached`) is carried `working`, whatever
 * v4 last recorded: v4 stopped watching it before the switch, and the harness may have taken a turn since (a background
 * job finishing, a monitor, a wake-up). Its `state.json` is carried WITHOUT v4's last turn (`sessionStateDocument`),
 * so v5's turn watch WRITES the first turn it sees itself, and only that moves the record to `idle`: the restart queued
 * for it (`queuedRestarts`) runs on v5's own evidence, never on a stale v4 turn. With no pane, the v4 status decides.
 */
export function liveState(state: { status?: string } | undefined, attached: boolean): 'starting' | 'idle' | 'working' {
  if (attached) return 'working';
  const status = state?.status;
  if (status === 'created' || status === 'starting') return 'starting';
  return ['awaiting_user', 'awaiting_question', 'waiting', 'rate_limited'].includes(status ?? '') ? 'idle' : 'working';
}

/** Ferrets' `restarts.json` body (the kernel stamps `format`): the daemon reads it back with the same entry schema. */
const RestartsBody = z.strictObject({ queued: z.array(RestartQueueEntrySchema) });

/**
 * One waiting restart for every ferret whose v4 harness is still in its pane (not stopped, with a pane handle). It is
 * not tied to the out-of-date check (`onlyIfOutdated: false`): the harness is restarted because it is a v4 one, whatever
 * its instructions say. It is the daemon's own recovery (`DAEMON_ORIGIN`, so a ferret another ferret started stays
 * fenced as on any relaunch), asked for by the owner who confirmed the switch, and `mid-turn` until the drain sees the
 * ferret idle.
 */
export function queuedRestarts(
  records: readonly {
    readonly id: string;
    readonly name: string;
    readonly state: string;
    readonly handle?: string | undefined;
  }[],
  since: string,
): z.infer<typeof RestartQueueEntrySchema>[] {
  return records
    .filter(record => record.state !== 'stopped' && record.handle !== undefined)
    .map(record =>
      RestartQueueEntrySchema.parse({
        id: record.id,
        name: record.name,
        since,
        reason: 'mid-turn',
        onlyIfOutdated: false,
        requestedBy: 'owner',
        origin: DAEMON_ORIGIN,
      }),
    );
}

/**
 * Who first started a v4 ferret, for the v5 record's `birth`. A ferret with a parent (started by another ferret) is an
 * AGENT's; so is one v4's own spawn stamp says another session or a warden created. One with no parent and no such stamp
 * was started by a person. Whatever cannot be told is an agent's: v5 fences an agent-born ferret on every relaunch.
 */
function v4Birth(config: V4Config): 'person' | 'agent' {
  if (config.parent !== undefined) return 'agent';
  const origin = config.provenance?.origin;
  if (origin === undefined || origin === 'human') return 'person';
  return 'agent';
}

/**
 * Why a converted ferret ended, from v4's `state.status`, for the record's `cause` (what Usage's insights read as how it
 * ended). Only a status that says the ferret ended is mapped; a ferret v4 never finished (or one the preview only holds) has
 * no cause. `failed` and `stalled` are an end that is a FAILURE to insights, written as `start_failed`: it is the one
 * failed cause the Warden NEVER revives. The Warden DOES read `cause` (`reviveEventsOf`, packages/plugins/warden/daemon/
 * fleet.ts): `terminal_gone`, `tmux_crashed`, `signal` and `agent_crashed` each rebuild a revivable death, so any of them
 * on a converted record would restart an old ferret v4 had given up on. `start_failed`, `stopped` and `completed` are
 * left alone for their own reasons (a test pins all three).
 */
export function v4EndCause(status: string | undefined): FerretEndCause | undefined {
  switch (status) {
    case 'completed':
      return { kind: 'completed' };
    case 'stopped':
    case 'interrupted':
      return { kind: 'stopped' };
    case 'failed':
    case 'stalled':
      return { kind: 'start_failed' };
    default:
      return undefined;
  }
}

/**
 * The login each v4 runtime names (`config/runtimes/<name>.yaml` `credential`, one login per runtime), keyed by runtime
 * name; a runtime whose file is missing, unreadable or names no valid login is simply absent (its ferrets carry no login).
 */
async function runtimeLogins(ctx: StepContext): Promise<ReadonlyMap<string, string>> {
  const logins = new Map<string, string>();
  const listing = await listV4Config(ctx.v4.home, ctx.v4.configOverrides);
  for (const file of listing.files) {
    if (file.address.kind !== 'runtime') continue;
    try {
      const credential = (await readV4Yaml(file)).get('credential', true);
      const parsed = isScalar(credential) ? LoginNameSchema.safeParse(credential.value) : undefined;
      if (parsed?.success === true) logins.set(file.address.name, parsed.data);
    } catch {
      // A runtime file the settings step reports on; here it only means no login for its ferrets.
    }
  }
  return logins;
}

export const ferretsStep: Step = {
  id: 'ferrets',
  title: 'Ferrets (identity, lineage, archive, tokens, session documents, pins)',
  owner: ['core-ferrets'],
  reads: [
    'state/sessions/<sid>/{config,state,terminal-pane,pins}.json, events.jsonl',
    'state/agent-pins.json',
    'fleet/ids.json',
    'state/{callsigns,archived-sessions,worktrees}.json',
    'state/forks/*.json',
  ],
  sealed: [],
  notCarried: [
    {
      what: 'the session index (state/index/sessions.sqlite) and the other derived SQLite caches',
      why: 'derived; rebuilt by ferrets.index-rebuild on first boot',
    },
    { what: 'v4 session-version markers', why: 'v5 files carry their own format' },
    { what: 'per-ferret environment.json', why: 'plaintext credential; never opened; the hash alone is carried' },
    {
      what: 'summary.md as an additional history entry',
      why: 'FerretHistoryEventSchema describes journal events only; no approved event type/sequence for this separate artifact (compaction-history.json is Usage’s: its step carries it)',
    },
    {
      what: 'system-callsigns.json counters',
      why: 'NamesDocumentSchema declares claims only, with no counter fields',
    },
    {
      what: 'per-session transfer-plan.json → moves/',
      why: 'MoveFiles still declares no v5 schema',
    },
    { what: 'auto-resume.json', why: 'AutoResumeFile declares no v5 schema' },
    {
      what: "v4's own waiting restarts (restarts/queue.json)",
      why: 'superseded: every ferret whose v4 harness is still in its pane is queued for a v5 restart at its next idle moment instead',
    },
    {
      what: 'transcript pointers outside fleet/homes or with no runtime UUID mapping',
      why: 'cannot point at a copied agent home safely; resume id is still kept in harnessConversation, and config.json drops the pointer as ferret.json does',
    },
    {
      what: 'conversion.fromFile outside the shared transcript pool',
      why: 'kept verbatim in config.json (a display pointer to the original transcript); only a pooled path has a known place in the new home',
    },
    {
      what: 'pins.json v, sessionId and updatedAt; agent-pins.json version',
      why: "v5's pin documents are { format: 1, pins } only: the session is the folder, and v4 rewrote updatedAt on every read",
    },
    {
      what: 'a damaged or foreign pins.json or agent-pins.json',
      why: 'v4 read it as no pins (FilePinRepository, FileAgentPinRepository), so the owner saw none; counted, never quoted',
    },
    {
      what: 'a pinned ferret whose session has no config.json',
      why: 'it names no ferret in the new home',
    },
    {
      what: 'a start option v5 refuses in details.json (e.g. a harness flag with a control character), and auto / teammateFallback',
      why: 'details.json is checked against StartOptionsSchema; the value stays in config.json. v4 recorded neither auto nor teammateFallback',
    },
    {
      what: 'fork plan.durable.boardAccess',
      why: 'the v4 preprocessor discarded this field; the strict v5 durable config has no such field',
    },
    {
      what: 'path rebasing inside frozen fork plans',
      why: 'plans and fingerprints are preserved as frozen historical decisions; changing them would invalidate daemon fingerprint checks',
    },
    { what: 'terminal-pane.sessionCreated', why: 'FerretRecordSchema declares only the pane handle' },
  ],
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried, sealed: [] };
    try {
      const records = [];
      const ids = await runtimeIds(ctx.v4.fleet);
      const runtimeOf = (config: { readonly agent: string }): string => {
        const name = runtimeName(config.agent);
        return (
          Object.entries(ids?.runtimes ?? {}).find(
            ([current, value]) => current === name || value.formerNames.includes(name),
          )?.[0] ?? name
        );
      };
      // The preview holds every ferret that is not a Claude Code one (or sits on a held runtime): no record, details
      // or token row. It would be a Codex ferret again the day a Codex login is added.
      const heldOnes = await heldRuntimes(ctx);
      const loginOf = await runtimeLogins(ctx);
      const held: NotCarried[] = [];
      const heldIds = new Set<string>();
      const sourceRecords = (await configs(ctx.v4.sessions)).filter(config => {
        if (!holdsCodex(ctx)) return true;
        const isCodex = config.harness !== 'claude';
        const onHeld = heldOnes.get(runtimeOf(config));
        if (!isCodex && onHeld === undefined) return true;
        held.push({
          what: `ferret ${config.id} (${isCodex ? 'Codex' : `on the held runtime ${runtimeOf(config)}`})`,
          why: isCodex ? CODEX_HELD_SENTENCE : heldReason(onHeld ?? 'unknown'),
        });
        heldIds.add(config.id);
        return false;
      });
      // A carried helper may name a lead that was held out: its `parent` then dangles. Harmless for v4 reach, but said.
      for (const config of sourceRecords)
        if (config.parent !== undefined && heldIds.has(config.parent))
          held.push({
            what: `ferret ${config.id} (a helper whose parent ${config.parent} is held out of the preview)`,
            why: `its parent field names ${config.parent}, which is not in the preview, so the link dangles`,
          });
      const ledgers = await prepareLedgers(ctx, sourceRecords);
      const details: DetailsSource[] = [];
      const tokens: { ferret: string; digest: string; issuedAt: string; revoked?: true; cutOff?: true }[] = [];
      for (const config of sourceRecords) {
        const state = await json(join(ctx.v4.sessions, config.id, 'state.json'), State);
        if (state !== undefined && state.id !== config.id) throw new Error('identity mismatch');
        const pane = await paneFor(ctx.v4.sessions, config);
        const status = state?.status;
        const stopped =
          status === undefined || ['completed', 'failed', 'stalled', 'stopped', 'interrupted'].includes(status);
        const runtime = runtimeOf(config);
        const preview = ctx.preview === true;
        // Still in its v4 pane at the switch: v5 attaches to it, then restarts it (M3).
        const attached = !stopped && !preview && pane !== undefined;
        const record = FerretRecordSchema.parse({
          format: 1,
          id: config.id,
          name: v5FerretName(config),
          parent: config.parent,
          role: config.parent === undefined ? 'lead' : 'helper',
          birth: v4Birth(config),
          harness: config.harness === 'claude' ? 'claude-code' : 'codex',
          runner: 'tmux',
          runtime,
          login: preview ? undefined : loginOf.get(runtime),
          folder: previewFolder(ctx, config.cwd, ledgers.worktreeFolders),
          state: stopped || preview ? 'stopped' : liveState(state, attached),
          harnessConversation: preview ? undefined : config.transcript?.harnessSessionId,
          transcript:
            config.transcript === undefined || preview
              ? undefined
              : rewriteTranscript(ctx, config.harness, config.transcript, ids),
          provenance: config.provenance,
          transferredFrom: config.transferredFrom,
          projectId: config.projectId,
          handle: preview ? undefined : pane?.paneId,
          createdAt: config.createdAt,
          cause: preview ? undefined : v4EndCause(status),
          stateAt: state?.finishedAt ?? state?.lastActivityAt ?? state?.startedAt ?? config.updatedAt,
        });
        records.push(record);
        details.push({ config, runtime, transcript: record.transcript, stopped: stopped || preview, attached });
        // M4: v4 hashes the full fys_ bearer with SHA-256, exactly the v5 token contract.
        // v4 has no issuance timestamp; creation is the known lower bound, not conversion time.
        // A person's cut-off (v4 `credentialRevoked`) is v5's `cutOff`. v4 drops the hash when it cuts a ferret off,
        // so there is often no hash to mark: write the same placeholder row v5's own `cutOff()` writes
        // (packages/core/ferrets/daemon/lib/tokens/tokens.ts), so the ferret is never relaunched until a person
        // resumes it. Dropping the mark would silently lift the cut-off.
        // The preview carries no token ledger: every live v4 pane holds the plaintext of its row's hash.
        if (preview) continue;
        if (config.credentialRevoked === true)
          tokens.push({
            ferret: config.id,
            digest: config.sessionCapabilityHash ?? '0'.repeat(64),
            issuedAt: config.createdAt,
            revoked: true as const,
            cutOff: true as const,
          });
        else if (config.sessionCapabilityHash !== undefined)
          tokens.push({ ferret: config.id, digest: config.sessionCapabilityHash, issuedAt: config.createdAt });
      }
      const tokenDocument = FerretTokensSchema.parse({ format: 1, tokens });
      const documents = await prepareDetails(ctx, details);
      for (const record of records)
        await ctx.v5.json(
          { ...FerretFiles, path: join('state/ferrets', record.id, 'ferret.json'), schema: FerretRecordSchema },
          record,
        );
      if (tokens.length > 0)
        await ctx.v5.json(
          { ...FerretTokensFile, path: join('state/ferrets', FerretTokensFile.path), schema: FerretTokensSchema },
          tokenDocument,
        );
      // M3: a ferret whose v4 harness is still in its pane runs v4's hooks, MCP server and folders (its CLAUDE_CONFIG_DIR /
      // CODEX_HOME is `<home>/fleet/homes/<uuid>`, which the new home does not have). Each is queued for v5's own
      // restart, which runs it again as a v5 harness at its next idle moment and never cuts a turn short (the drain waits
      // for `idle`); a restart that fails is journalled on the ferret (`session.restart_gave_up`), never dropped silently.
      const restarts = queuedRestarts(records, new Date().toISOString());
      if (restarts.length > 0)
        await ctx.v5.stamped(
          { path: join('state/ferrets', RestartsFile.path), format: RestartsFile.format, schema: RestartsBody },
          { queued: restarts },
        );
      await ledgers.write();
      await documents.write();
      return {
        ...base,
        status: 'converted',
        notCarried: [...this.notCarried, ...held, ...documents.notCarried],
        kept: [
          { what: 'ferret records (including archived sessions)', count: records.length },
          { what: 'ferret credential hashes', count: tokens.length },
          ...ledgers.kept,
          ...documents.kept,
        ],
      };
    } catch {
      return {
        ...base,
        status: 'failed',
        note: 'cannot convert ferret input: invalid data or an unavailable file',
        kept: [],
      };
    }
  },
};
