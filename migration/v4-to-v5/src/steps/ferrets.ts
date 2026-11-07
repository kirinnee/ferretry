import { FerretFiles, FerretRecordSchema, FerretTokensFile, FerretTokensSchema } from '@ferretry/core-ferrets/contract';
import { join } from 'node:path';
import type { StepReport } from '../report.ts';
import { configs, json, paneFor, runtimeIds, runtimeName, State } from '../v4/ferrets.ts';
import type { Step } from './index.ts';

export const ferretsStep: Step = {
  id: 'ferrets',
  title: 'Ferrets (identity, lineage, archive, tokens)',
  owner: ['core-ferrets'],
  reads: ['state/sessions/<sid>/{config,state,terminal-pane}.json', 'fleet/ids.json'],
  sealed: [],
  notCarried: [
    { what: 'derived indexes (SQLite caches)', why: 'v5 rebuilds every cache from the kept files' },
    { what: 'v4 session-version markers', why: 'v5 files carry their own format' },
    { what: 'per-ferret environment.json', why: 'plaintext credential; never opened; the hash alone is carried' },
    {
      what: 'events.jsonl, summary.md and compaction-history.json → history.jsonl',
      why: 'FerretHistoryFiles declares no v5 entry schema',
    },
    {
      what: 'callsigns.json, system-callsigns.json and fleet/ids.json formerNames → names.json',
      why: 'NamesFile declares no v5 schema',
    },
    {
      what: 'archived-sessions.json → archive.json',
      why: 'ArchiveFile declares no v5 schema; archived ferret records are kept in place',
    },
    { what: 'worktrees.json', why: 'WorktreesFile declares no v5 schema' },
    {
      what: 'forks/*.json and per-session transfer-plan.json → forks/ and moves/',
      why: 'ForkFiles and MoveFiles declare no v5 schemas',
    },
    { what: 'auto-resume.json and restarts/queue.json', why: 'AutoResumeFile and RestartsFile declare no v5 schemas' },
    {
      what: 'provenance, transferredFrom, migration/migrations and conversion',
      why: 'FerretRecordSchema has parent but no other v4 lineage fields',
    },
    {
      what: 'projectId, focusTask, focusAnchor and boardSkip',
      why: 'FerretRecordSchema has folder but no project or card fields',
    },
    {
      what: 'transcript.home, transcript.file, transcript.v, transcript.identity, transcript.baseline, transcript.correlationToken and transcript.resolvedAt',
      why: 'FerretRecordSchema declares only harnessConversation; no fields for rewritten home/file paths',
    },
    {
      what: 'config.nameSource, label, teammate, incarnation, runtimeGeneration, command, prompt, modelHint, model, launchReasoningEffort, launchFast, launchSettings, harnessFlags, mode, remoteControl, hypermedia, pack, agenda, compactAt, intervalSeconds, timeoutSeconds, nudgeAfterSeconds, killAfterSeconds, directSendMaxChars, resumeMenuChoice, maxSnapshots, retry and turn',
      why: 'FerretRecordSchema has no fields for these v4 config/state facts',
    },
    {
      what: 'state.turn, pid, startedAt, finishedAt, lastActivityAt, lastSnapshotAt, lastDiffAt, exitCode, reason, health, promptReady, remoteControlUrl, openTools, pendingQuestion, lastAnsweredQuestionToolUseId, lastTranscriptAt, lastPaneAt, lastCounterAdvanceAt, lastTokenAdvanceAt, lastSubprocessAt, subprocessSince, nudgedAt, needsHuman, needsHumanKind, agenda, contextPercent, contextTokens, contextAt, contextWindow, usage5hPercent, usageWeeklyPercent, usage5hResetAt, usageWeeklyResetAt, usageAtLimit, usageAuthOk, launchedAt, harnessStartupMs, harnessNotReadyAfterMs, launchInstructions, observedModel, observedModelAt, observedReasoningEffort, observedFast, activity, lastToolStartedAt, quota, retryAttempt, turnCompleted, turnState, turnStateAt, turnPrompt, permissionRequest, harnessDialog, waiting and waitingCreditSeconds',
      why: 'FerretRecordSchema has no observation fields; only one timestamp is selected for stateAt',
    },
    {
      what: 'config.updatedAt and the exact v4 state.status',
      why: 'represented by one stateAt timestamp and the four-state v5 lifecycle, not stored separately',
    },
    { what: 'terminal-pane.sessionCreated', why: 'FerretRecordSchema declares only the pane handle' },
  ],
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried, sealed: [] };
    try {
      const records = [];
      const ids = await runtimeIds(ctx.v4.fleet);
      const tokens: { ferret: string; digest: string; issuedAt: string; revoked?: true }[] = [];
      for (const config of await configs(ctx.v4.sessions)) {
        const state = await json(join(ctx.v4.sessions, config.id, 'state.json'), State);
        if (state !== undefined && state.id !== config.id) throw new Error('identity mismatch');
        const pane = await paneFor(ctx.v4.sessions, config);
        const status = state?.status;
        const stopped =
          status === undefined || ['completed', 'failed', 'stalled', 'stopped', 'interrupted'].includes(status);
        const name = runtimeName(config.agent);
        const runtime =
          Object.entries(ids?.runtimes ?? {}).find(
            ([current, value]) => current === name || value.formerNames.includes(name),
          )?.[0] ?? name;
        const record = FerretRecordSchema.parse({
          format: 1,
          id: config.id,
          name: config.name,
          parent: config.parent,
          role: config.parent === undefined ? 'lead' : 'helper',
          harness: config.harness === 'claude' ? 'claude-code' : 'codex',
          runner: 'tmux',
          runtime,
          folder: config.cwd,
          state: stopped
            ? 'stopped'
            : status === 'created' || status === 'starting'
              ? 'starting'
              : ['awaiting_user', 'awaiting_question', 'waiting', 'rate_limited'].includes(status ?? '')
                ? 'idle'
                : 'working',
          harnessConversation: config.transcript?.harnessSessionId,
          handle: pane?.paneId,
          createdAt: config.createdAt,
          stateAt: state?.finishedAt ?? state?.lastActivityAt ?? state?.startedAt ?? config.updatedAt,
        });
        records.push(record);
        // M4: v4 hashes the full fys_ bearer with SHA-256, exactly the v5 token contract.
        // v4 has no issuance timestamp; creation is the known lower bound, not conversion time.
        if (config.sessionCapabilityHash !== undefined)
          tokens.push({
            ferret: config.id,
            digest: config.sessionCapabilityHash,
            issuedAt: config.createdAt,
            ...(config.credentialRevoked === true ? { revoked: true as const } : {}),
          });
      }
      const tokenDocument = FerretTokensSchema.parse({ format: 1, tokens });
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
      return {
        ...base,
        status: 'converted',
        kept: [
          { what: 'ferret records (including archived sessions)', count: records.length },
          { what: 'ferret credential hashes', count: tokens.length },
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
