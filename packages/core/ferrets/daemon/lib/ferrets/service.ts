import type { AsksApi } from '@ferretry/core-asks/contract';
import type { ChildEnvironment, VaultApi } from '@ferretry/core-vault/contract';
import type { FencedPath, HookDecision, InstructionEntry } from '@ferretry/kernel/contract';
import { err, type Instant, ok, type Result } from '@ferretry/std';
import type {
  FerretChangedPayload,
  FerretId,
  FerretRecord,
  FerretsApi,
  FerretState,
  FerretSummary,
  Harness,
  HarnessKey,
  LaunchPart,
  LaunchPartSource,
  LaunchSpec,
  PackId,
  Runner,
  RunnerHandle,
  Sitrep,
  SitrepLine,
  SitrepLineSource,
  StartDecideInput,
  StartFailure,
  StartRequest,
} from '../../../contract/index.ts';
import { HARNESS_KEYS } from '../../../contract/index.ts';
import type { FerretRegistry, FerretFilter } from '../registry/registry.ts';
import { type FerretTokenDirectory, issueToken, type TokenEntry } from '../tokens/tokens.ts';

/**
 * THE FERRETS PORT (§2.2): who each ferret is and its state, and the launch pipeline. Starting and stopping are
 * done by a harness plugin through a runner; this asks `start.decide` takers first, then the harness, with the
 * Vault's child environment and what `launch.parts` takers add. Identity, lineage and the token are decided here.
 *
 * Order of a start (today's `session/lifecycle` service, reduced to the 5.0 kinds): mint the id, claim the name,
 * check the folder, ask `start.decide`, issue the token and record `starting` (so a crash leaves a record a resume
 * can find), then hand the harness its launch; on success the record is `working` with its runner handle, on any
 * failure `stopped` with its token revoked.
 */

/** Today's launch variables: the ferret's own bearer and id, read by `fy` inside the pane. */
export const FERRET_TOKEN_VARIABLE = 'FY_SESSION_TOKEN';
export const FERRET_ID_VARIABLE = 'FY_SESSION_ID';

/** Everything the service reaches outside its own memory. The daemon half binds these to kernel ports. */
export interface FerretsPorts {
  /** Resolves once the held ferret records are loaded (a read before then would see no ferret). */
  ready?(): Promise<void>;
  now(): Instant;
  /** A fresh, server-minted ferret id; a request never names one (today's `TimeSessionIdFactory`). */
  newId(): FerretId;
  /** A name nobody running holds, when the request named none. */
  newName(taken: (name: string) => boolean): string;
  save(record: FerretRecord): Promise<void>;
  saveTokens(entries: readonly TokenEntry[]): Promise<void>;
  harness(key: HarnessKey): Harness | undefined;
  harnessKeys(): readonly HarnessKey[];
  runner(): Runner | undefined;
  decide(input: StartDecideInput): Promise<HookDecision>;
  launchParts(): readonly LaunchPartSource[];
  sitrepSources(): readonly SitrepLineSource[];
  instructions(): readonly InstructionEntry[];
  /** The ferret's home under the `agent-homes` root. */
  home(ferret: FerretId): FencedPath;
  /** The folder fenced by the kernel's `work` root, or why not. */
  folder(path: string): Result<FencedPath, string>;
  changed(payload: FerretChangedPayload): void;
  vault: Pick<VaultApi, 'childEnvironment'>;
  asks: Pick<AsksApi, 'open'>;
}

const failed = (code: StartFailure['code'], reason: string): Result<never, StartFailure> =>
  err({ code, reason } as StartFailure);

export class FerretsService implements FerretsApi {
  constructor(
    private readonly registry: FerretRegistry,
    private readonly tokens: FerretTokenDirectory,
    private readonly ports: FerretsPorts,
  ) {}

  async get(ferret: FerretId): Promise<FerretSummary | undefined> {
    return this.registry.summary(ferret);
  }

  async list(filter?: FerretFilter): Promise<readonly FerretSummary[]> {
    return this.registry.list(filter);
  }

  mayTouch(caller: FerretId, target: FerretId): boolean {
    return this.registry.mayTouch(caller, target);
  }

  children(ferret: FerretId): readonly FerretId[] {
    return this.registry.children(ferret);
  }

  harnesses(): readonly HarnessKey[] {
    return this.ports.harnessKeys();
  }

  /** The handle `ferret.json` keeps while the ferret runs; a stop clears it. */
  async handle(ferret: FerretId): Promise<RunnerHandle | undefined> {
    await this.ports.ready?.();
    return this.registry.get(ferret)?.handle as RunnerHandle | undefined;
  }

  async start(request: StartRequest): Promise<Result<FerretId, StartFailure>> {
    if (request.parent !== undefined && this.registry.get(request.parent) === undefined)
      return failed('refused', `no ferret ${request.parent} to be the lead of this one`);
    const name = request.name?.trim() || this.ports.newName(candidate => this.registry.nameHolder(candidate) !== undefined);
    const holder = this.registry.nameHolder(name);
    if (holder !== undefined) return failed('refused', `the name ${name} is held by running ferret ${holder}`);
    const folder = this.ports.folder(request.folder);
    if (!folder.ok) return failed('folder', folder.error);
    const harnessKey = request.harness ?? this.ports.harnessKeys()[0];
    if (harnessKey === undefined || !(HARNESS_KEYS as readonly string[]).includes(harnessKey))
      return failed('harness_unavailable', 'no harness plugin is on');
    const id = this.ports.newId();
    const role = request.role ?? (request.parent === undefined ? 'lead' : 'helper');
    const decision = await this.ports.decide({
      ferret: id,
      name,
      role,
      ...(request.parent === undefined ? {} : { parent: request.parent }),
      ...(request.pack === undefined ? {} : { pack: request.pack }),
      harness: harnessKey,
      ...(request.runtime === undefined ? {} : { runtime: request.runtime }),
      ...(request.login === undefined ? {} : { login: request.login }),
      folder: folder.value,
      by: request.by,
    });
    if (!decision.allow) return failed('refused', decision.reason);
    const at = this.ports.now();
    const record: FerretRecord = {
      format: 1,
      id,
      name,
      ...(request.parent === undefined ? {} : { parent: request.parent }),
      ...(request.pack === undefined ? {} : { pack: request.pack }),
      role,
      harness: harnessKey,
      runner: 'tmux',
      ...(request.runtime === undefined ? {} : { runtime: request.runtime }),
      ...(request.login === undefined ? {} : { login: request.login }),
      folder: folder.value,
      state: 'starting',
      createdAt: at,
      stateAt: at,
    };
    await this.write(record, undefined, 'started');
    return await this.launch(record, request.prompt, undefined);
  }

  async stop(ferret: FerretId, how: 'polite' | 'now'): Promise<void> {
    const record = this.registry.get(ferret);
    if (record === undefined || record.state === 'stopped') return;
    const harness = this.ports.harness(record.harness);
    const runner = this.ports.runner();
    if (record.handle !== undefined && harness !== undefined && runner !== undefined)
      await harness.stop(ferret, record.handle as RunnerHandle, runner, how);
    await this.settle(record, 'stopped', 'stopped');
  }

  async resume(ferret: FerretId): Promise<Result<FerretId, StartFailure>> {
    const record = this.registry.get(ferret);
    if (record === undefined) return failed('refused', `no ferret ${ferret}`);
    if (record.state !== 'stopped') return ok(ferret);
    const decision = await this.ports.decide({
      ferret,
      name: record.name,
      role: record.role,
      ...(record.parent === undefined ? {} : { parent: record.parent }),
      ...(record.pack === undefined ? {} : { pack: record.pack }),
      harness: record.harness,
      ...(record.runtime === undefined ? {} : { runtime: record.runtime }),
      ...(record.login === undefined ? {} : { login: record.login }),
      folder: record.folder,
      by: 'resume',
    });
    if (!decision.allow) return failed('refused', decision.reason);
    const starting: FerretRecord = { ...record, state: 'starting', stateAt: this.ports.now() };
    await this.write(starting, record.state, 'state');
    return await this.launch(starting, undefined, record.harnessConversation);
  }

  /**
   * Adopts a live process by its runner handle WITHOUT restarting it (spine D15): the runner confirms the handle is
   * a live ferret pane, and the record takes the handle and `working`. No token is issued: the adopted process keeps
   * the bearer it was started with, which `tokens.json` already holds.
   */
  async attach(ferret: FerretId, handle: RunnerHandle): Promise<Result<FerretId, StartFailure>> {
    const record = this.registry.get(ferret);
    if (record === undefined) return failed('refused', `no ferret ${ferret}`);
    const runner = this.ports.runner();
    if (runner === undefined) return failed('runner_unavailable', 'no runner plugin is on');
    const adopted = await runner.attach(handle);
    if (!adopted.ok) return failed('failed', `the runner would not adopt ${handle}: ${adopted.error}`);
    const working: FerretRecord = {
      ...record,
      state: 'working',
      handle: adopted.value.handle,
      stateAt: this.ports.now(),
    };
    await this.write(working, record.state, 'state');
    return ok(ferret);
  }

  async sitrep(ferret: FerretId): Promise<Sitrep | undefined> {
    const summary = this.registry.summary(ferret);
    if (summary === undefined) return undefined;
    const sources = this.ports.sitrepSources();
    const lines = (
      await Promise.all(sources.map(source => source.lines(ferret).catch(() => [] as readonly SitrepLine[])))
    ).flat();
    const blockers = await this.ports.asks
      .open({ ferret } as Parameters<AsksApi['open']>[0])
      .then(open => open.map(ask => ask.id as string))
      .catch(() => [] as string[]);
    return { ferret: summary, lines, blockers };
  }

  /** Renames a ferret (today's `SessionRenameService`, reduced to the record): a running ferret's name is unique. */
  async rename(ferret: FerretId, name: string): Promise<Result<FerretSummary, string>> {
    const record = this.registry.get(ferret);
    if (record === undefined) return err(`no ferret ${ferret}`);
    const trimmed = name.trim();
    const holder = this.registry.nameHolder(trimmed);
    if (holder !== undefined && holder !== ferret) return err(`the name ${trimmed} is held by running ferret ${holder}`);
    await this.write({ ...record, name: trimmed }, record.state, 'renamed');
    return ok(this.registry.summary(ferret) as FerretSummary);
  }

  /** Revokes a ferret's token (owner only at the route); it can no longer call the daemon until it restarts. */
  async revokeToken(ferret: FerretId): Promise<boolean> {
    const revoked = this.tokens.revoke(ferret);
    if (revoked) await this.ports.saveTokens(this.tokens.snapshot());
    return revoked;
  }

  private async launch(
    record: FerretRecord,
    prompt: string | undefined,
    conversation: string | undefined,
  ): Promise<Result<FerretId, StartFailure>> {
    const harness = this.ports.harness(record.harness);
    if (harness === undefined) return await this.abandon(record, 'harness_unavailable', `${record.harness} is off`);
    const runner = this.ports.runner();
    if (runner === undefined) return await this.abandon(record, 'runner_unavailable', 'no runner plugin is on');
    const issued = issueToken(record.id, this.ports.now());
    this.tokens.add(issued.entry);
    await this.ports.saveTokens(this.tokens.snapshot());
    const base: Omit<LaunchSpec, 'parts'> = {
      ferret: record.id,
      name: record.name,
      role: record.role,
      ...(record.parent === undefined ? {} : { parent: record.parent }),
      ...(record.pack === undefined ? {} : { pack: record.pack as PackId }),
      harness: record.harness,
      ...(record.runtime === undefined ? {} : { runtime: record.runtime }),
      ...(record.login === undefined ? {} : { login: record.login }),
      folder: record.folder as FencedPath,
      home: this.ports.home(record.id),
      instructions: this.ports.instructions().filter(
        entry =>
          (entry.when.role === undefined || entry.when.role === 'any' || entry.when.role === record.role) &&
          (entry.when.harness === undefined || entry.when.harness === record.harness),
      ),
      ...(prompt === undefined ? {} : { prompt }),
    };
    const parts = (
      await Promise.all(
        this.ports.launchParts().map(source => source.parts(base).catch(() => [] as readonly LaunchPart[])),
      )
    ).flat();
    const spec: LaunchSpec = { ...base, parts };
    const env = await this.environment(record.id, issued.token, parts);
    if (!env.ok) return await this.abandon(record, 'login_unavailable', env.error);
    const started =
      conversation === undefined
        ? await harness.start(spec, runner, env.value)
        : await harness.resume(spec, runner, env.value, conversation);
    if (!started.ok) {
      const code = started.error === 'unavailable' ? 'runner_unavailable' : 'failed';
      return await this.abandon(record, code, `the harness could not start: ${started.error}`);
    }
    const working: FerretRecord = {
      ...record,
      state: 'working',
      handle: started.value.running.handle,
      ...(started.value.harnessConversation === undefined
        ? {}
        : { harnessConversation: started.value.harnessConversation }),
      stateAt: this.ports.now(),
    };
    await this.write(working, record.state, 'state');
    return ok(record.id);
  }

  private async environment(
    ferret: FerretId,
    token: string,
    parts: readonly LaunchPart[],
  ): Promise<Result<ChildEnvironment, string>> {
    const env: Record<string, string> = {};
    for (const part of parts) if (part.kind === 'env' || part.kind === 'shell') Object.assign(env, part.env);
    env[FERRET_ID_VARIABLE] = ferret;
    env[FERRET_TOKEN_VARIABLE] = token;
    const resolved = await this.ports.vault.childEnvironment(ferret, env);
    return resolved.ok ? ok(resolved.value) : err(`unknown secrets: ${resolved.error.unknown.join(', ')}`);
  }

  private async abandon(
    record: FerretRecord,
    code: StartFailure['code'],
    reason: string,
  ): Promise<Result<FerretId, StartFailure>> {
    await this.settle(record, 'stopped', 'stopped');
    return failed(code, reason);
  }

  private async settle(record: FerretRecord, state: FerretState, change: FerretChangedPayload['change']): Promise<void> {
    if (this.tokens.revoke(record.id)) await this.ports.saveTokens(this.tokens.snapshot());
    const { handle: _handle, ...rest } = record;
    await this.write({ ...rest, state, stateAt: this.ports.now() }, record.state, change);
  }

  private async write(
    record: FerretRecord,
    previous: FerretState | undefined,
    change: FerretChangedPayload['change'],
  ): Promise<void> {
    await this.ports.save(record);
    this.registry.put(record);
    this.ports.changed({
      ferret: record.id,
      state: record.state,
      ...(previous === undefined ? {} : { previous }),
      change,
    });
  }
}
