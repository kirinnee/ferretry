/**
 * `FerretsApi` is composed (generated) from `contract/ports/*.port.ts`. This pins that the composition is the SAME
 * interface the single hand-written one was: `FerretsApiAtBase` is that interface copied from the commit before the
 * split (signatures only, doc comments left out), and a member added, dropped, renamed, made optional or retyped by the
 * split makes the `Equal` below fail the typecheck.
 */
import { expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import type { Instant, Result } from '@ferretry/std';
import type { HarnessHistorySource } from '../../contract/history.ts';
import type { FerretState, FerretSummary, HarnessKey, PackId } from '../../contract/ids.ts';
import type { ConversationImport, HarnessFacts, RunnerHandle, TurnUsage } from '../../contract/kinds.ts';
import type { LaunchOrigin } from '../../contract/launch-origin.ts';
import type { RelocatedFile, RelocationSource } from '../../contract/ports/reads.port.ts';
import type {
  RepoWorktreeListResponse,
  RemovedWorktree,
  WorktreeRemovalDecision,
  GuardedWorktreeRemovalRequest,
} from '../../contract/worktrees.ts';
import type {
  AutoResumeReport,
  FerretAddress,
  FerretFolderListing,
  FerretHarness,
  FerretIngestEvidence,
  FerretPaneLimit,
  FerretPrompt,
  FerretRuntimeRecord,
  FerretRuntimeRename,
  FerretsApi,
  FerretTurns,
  ManagedWorktreeSummary,
  MoveFailure,
  MoveOptions,
  ResumeOptions,
  ForksApi,
  RuntimeControlApi,
  Sitrep,
  StartFailure,
  StartRequest,
} from '../../contract/port.ts';
import type { AgentControl, LimitsFile } from '../../contract/state.ts';
import type { CompactAt } from '../../contract/view/compact-at.ts';

interface FerretsApiAtBase {
  effectiveLimits?(): Promise<LimitsFile>;
  get(ferret: FerretId): Promise<FerretSummary | undefined>;
  resolve(reference: string): Promise<FerretAddress>;
  list(filter?: {
    readonly state?: FerretState;
    readonly parent?: FerretId;
    readonly pack?: PackId;
  }): Promise<readonly FerretSummary[]>;
  rosterComplete?(): Promise<boolean>;
  mayTouch(caller: FerretId, target: FerretId): boolean;
  children(ferret: FerretId): readonly FerretId[];
  harnesses(): readonly HarnessKey[];
  harnessFacts(key: HarnessKey): HarnessFacts | undefined;
  harnessRuntime?: FerretsApi['harnessRuntime'];
  importConversation?(
    harness: HarnessKey,
    input: ConversationImport,
  ): Promise<Result<void, { readonly reason: string }>>;
  historySources?(): Promise<
    readonly { readonly harness: HarnessKey; readonly sources: readonly HarnessHistorySource[] }[]
  >;
  start(request: StartRequest, origin: LaunchOrigin): Promise<Result<FerretId, StartFailure>>;
  stop(ferret: FerretId, how: 'polite' | 'now', reason?: string): Promise<void>;
  resume(
    ferret: FerretId,
    message: string | undefined,
    options: ResumeOptions,
  ): Promise<Result<FerretId, StartFailure>>;
  attach(ferret: FerretId, handle: RunnerHandle, origin: LaunchOrigin): Promise<Result<FerretId, StartFailure>>;
  handle(ferret: FerretId): Promise<RunnerHandle | undefined>;
  workFolder(ferret: FerretId): Promise<{ readonly folder: string } | undefined>;
  listFolder?(ferret: FerretId, path: string | undefined, caller?: FerretId): Promise<FerretFolderListing | undefined>;
  sitrep(ferret: FerretId): Promise<Sitrep | undefined>;
  summary(ferret: FerretId): Promise<string | undefined>;
  managedWorktrees?(): Promise<readonly ManagedWorktreeSummary[]>;
  repoWorktrees?(commonDir: string): Promise<RepoWorktreeListResponse>;
  checkWorktreeRemoval?(path: string, currentWorkingDirectory?: string): Promise<WorktreeRemovalDecision>;
  removeWorktree?(request: GuardedWorktreeRemovalRequest): Promise<RemovedWorktree>;
  systemCallsign?(prefix: 'warden' | 'learning' | 'pack'): Promise<string>;
  agentControl(ferret: FerretId): Promise<AgentControl>;
  lastAutoResume?(): Promise<AutoResumeReport | null>;
  displayModel?(ferret: FerretId): Promise<string | undefined>;
  ingestEvidence?(ferret: FerretId): Promise<FerretIngestEvidence | undefined>;
  turnUsage(ferret: FerretId, since?: Instant): Promise<readonly TurnUsage[] | undefined>;
  harness?(ferret: FerretId, caller?: FerretId): Promise<FerretHarness | undefined>;
  turns?(ferret: FerretId, caller?: FerretId): Promise<FerretTurns | undefined>;
  prompt?(ferret: FerretId, caller?: FerretId): Promise<FerretPrompt | undefined>;
  lastSnapshot?(ferret: FerretId, caller?: FerretId): Promise<string | undefined>;
  move?(
    ferret: FerretId,
    runtime: string,
    options: MoveOptions,
    caller?: FerretId,
  ): Promise<Result<FerretSummary, MoveFailure>>;
  adoptTitle?(ferret: FerretId, title: string): Promise<'adopted' | 'kept'>;
  compactAt?(ferret: FerretId, caller?: FerretId): Promise<CompactAt | undefined>;
  setCompactAt?(ferret: FerretId, value: CompactAt | undefined, caller?: FerretId): Promise<void>;
  paneLimits?(): Promise<readonly FerretPaneLimit[]>;
  runtimeRecords?(): Promise<readonly FerretRuntimeRecord[]>;
  repointRuntime?(rename: FerretRuntimeRename): Promise<number>;
  markStalled?(ferret: FerretId, stalled: boolean): Promise<boolean>;
  exclusive?<T>(ferret: FerretId, work: () => Promise<T>): Promise<T>;
  runtimeControl?: RuntimeControlApi['runtimeControl'];
  relocationSource?(ferret: FerretId): Promise<RelocationSource | undefined>;
  relocationRestore?(ferret: FerretId, files: readonly RelocatedFile[]): Promise<void>;
  forks?: ForksApi['forks'];
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails the typecheck, not the run, if the composed interface is not exactly the one it replaced. */
const composedIsTheBaseInterface: Equal<FerretsApiAtBase, FerretsApi> = true;

test('FerretsApi is the interface it was before it was split into slices', () => {
  expect(composedIsTheBaseInterface).toBe(true);
});
