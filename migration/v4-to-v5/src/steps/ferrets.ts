import {
  FerretFiles,
  FerretNameSchema,
  FerretRecordSchema,
  FerretTokensFile,
  FerretTokensSchema,
} from '@ferretry/core-ferrets/contract';
import { join } from 'node:path';
import type { NotCarried, StepReport } from '../report.ts';
import { CODEX_HELD_SENTENCE, heldReason, heldRuntimes, holdsCodex } from './preview-hold.ts';
import { previewFolder, rewriteTranscript } from '../v5/harness-paths.ts';
import { configs, json, paneFor, runtimeIds, runtimeName, State, type V4Config } from '../v4/ferrets.ts';
import type { Step } from './index.ts';
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
      what: 'summary.md and compaction-history.json as additional history entries',
      why: 'FerretHistoryEventSchema describes journal events only; no approved event type/sequence for these separate artifacts',
    },
    {
      what: 'system-callsigns.json counters',
      why: 'NamesDocumentSchema declares claims only, with no counter fields',
    },
    {
      what: 'per-session transfer-plan.json → moves/',
      why: 'MoveFiles still declares no v5 schema',
    },
    { what: 'auto-resume.json and restarts/queue.json', why: 'AutoResumeFile and RestartsFile declare no v5 schemas' },
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
          folder: previewFolder(ctx, config.cwd, ledgers.worktreeFolders),
          state:
            stopped || preview
              ? 'stopped'
              : status === 'created' || status === 'starting'
                ? 'starting'
                : ['awaiting_user', 'awaiting_question', 'waiting', 'rate_limited'].includes(status ?? '')
                  ? 'idle'
                  : 'working',
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
          stateAt: state?.finishedAt ?? state?.lastActivityAt ?? state?.startedAt ?? config.updatedAt,
        });
        records.push(record);
        details.push({ config, runtime, transcript: record.transcript, stopped: stopped || preview });
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
