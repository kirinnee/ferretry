import type { FerretsApi, HarnessKey, StartRequest } from '@ferretry/core-ferrets/contract';
import type { Clock, Log } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import type { CloneCrypto, PrivateKeyHandle } from '@ferretry/std/sealing';
import { z } from 'zod';
import type { VaultApi } from '@ferretry/core-vault/contract';
import { cloneFolderName, type ProjectsApi } from '@ferretry/plugin-projects/contract';
import type { GitAccountsApi } from '@ferretry/plugin-git-accounts/contract';
import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import {
  type ImportRequest,
  type ImportResponse,
  type Needs,
  type RelocateOffer,
  type TargetPreflightRequest,
  type TargetPreflightResponse,
} from '../../contract/index.ts';
import type { Checkout } from './checkout.ts';
import { toHex } from './hex.ts';
import type { OfferBook } from './offer.ts';
import { BundleRefused, type OpenedBundle, openBundle } from './open-bundle.ts';
import { RelocateRefused } from './relocation.ts';
import { OfferError } from './offer.ts';

/** The ferrets this machine took from another: where each came from. The one thing the target keeps. */
interface ReceivedLedger {
  record(
    ferret: string,
    entry: { readonly daemonId: string; readonly ferretId: string; readonly at: Instant },
  ): Promise<void>;
}

/** The ferret's own record, as the source wrote it (`record.json`): only the fields a start here needs. */
const RecordSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  mode: z.enum(['auto', 'interactive']).optional(),
  harness: z.string().min(1),
  runtime: z.string().optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  fast: z.boolean().optional(),
  title: z.string().min(1).optional(),
});

export interface ImporterDeps {
  readonly crypto: CloneCrypto;
  readonly ownDaemonId: string;
  readonly clock: Pick<Clock, 'now'>;
  readonly offers: OfferBook;
  readonly ferrets: Pick<FerretsApi, 'start' | 'stop' | 'harnesses'>;
  /** The optional neighbours: absent means that plugin is off, and a move needing it is refused with a sentence. */
  readonly projects: () => Pick<ProjectsApi, 'list' | 'register' | 'remove'> | undefined;
  readonly gitAccounts: () => Pick<GitAccountsApi, 'list'> | undefined;
  readonly runtimes: () => Pick<RuntimesApi, 'resolve' | 'default'> | undefined;
  readonly vault: () => Pick<VaultApi, 'has'> | undefined;
  readonly checkout: Checkout;
  readonly received: ReceivedLedger;
  readonly log: Pick<Log, 'warn'>;
}

/** Where the ferret's repository is, found or to be made. */
type Resolved =
  | { readonly kind: 'found'; readonly repo: string }
  | { readonly kind: 'clone'; readonly url: string; readonly destination: string };

interface Evaluation {
  readonly refusals: string[];
  readonly project: TargetPreflightResponse['project'];
  readonly resolved?: Resolved;
  readonly runtime?: string;
  readonly missingSecrets: string[];
}

const joinPath = (base: string, relative: string): string =>
  relative === '.' ? base : `${base === '/' ? '' : base}/${relative}`;
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32) || 'work';
const sentence = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message !== '' ? error.message : fallback;

/**
 * The TARGET end of a move: open an offer, say what this machine can and cannot take, receive the sealed chunks, and import.
 *
 * WRITES NOTHING UNTIL IT HAS PROVED EVERYTHING it can: the offer is open, every chunk authenticates and every hash holds,
 * the harness, the runtime login, the secret names and the project are all here, and the places to write are free. Only then
 * does it write, step by step, remembering each undo; a failure takes back exactly what this import made and nothing else.
 * The one thing that cannot be taken back is the ferret's own record once a start has made it (Ferrets never deletes a
 * ferret): a start that fails leaves its stopped `start_failed` record, and every file this import made is removed.
 */
export class Importer {
  #busy = false;

  constructor(private readonly deps: ImporterDeps) {}

  /** What this machine can take: nothing is written and the offer is not spent. */
  async preflight(offerId: string, request: TargetPreflightRequest): Promise<TargetPreflightResponse> {
    this.#guarded(() => this.deps.offers.check(offerId));
    const found = await this.#evaluate(request.needs, request.cloneInto);
    return {
      ok: found.refusals.length === 0,
      refusals: found.refusals,
      project: found.project,
      ...(found.runtime === undefined ? {} : { runtime: found.runtime }),
      missingSecrets: found.missingSecrets,
    };
  }

  /** Receives one sealed chunk for the offer. It is kept in memory only. */
  receive(offerId: string, index: number, chunk: Uint8Array): void {
    this.#guarded(() => this.deps.offers.receive(offerId, index, chunk));
  }

  async import(offerId: string, request: ImportRequest): Promise<ImportResponse> {
    if (this.#busy) throw new RelocateRefused(409, 'another move is being received on this machine', 'import_busy');
    this.#busy = true;
    try {
      // From here the offer is spent, whatever happens next: one offer opens one bundle.
      const spent = this.#guarded(() => this.deps.offers.take(offerId));
      const bundle = await this.#open(spent, request);
      return await this.#receive(bundle, request);
    } finally {
      this.#busy = false;
    }
  }

  async #open(
    spent: {
      readonly offer: RelocateOffer;
      readonly privateKey: PrivateKeyHandle;
      readonly chunks: ReadonlyMap<number, Uint8Array>;
    },
    request: ImportRequest,
  ): Promise<OpenedBundle> {
    try {
      return await openBundle({
        crypto: this.deps.crypto,
        offer: spent.offer,
        privateKey: spent.privateKey,
        header: request.header,
        chunks: spent.chunks,
        ownDaemonId: this.deps.ownDaemonId,
      });
    } catch (error) {
      throw error instanceof BundleRefused ? new RelocateRefused(400, error.message, 'bundle_refused') : error;
    }
  }

  async #receive(bundle: OpenedBundle, request: ImportRequest): Promise<ImportResponse> {
    const { manifest } = bundle;
    const entry = (kind: string) => bundle.entries.find(candidate => candidate.kind === kind);
    const recorded = RecordSchema.safeParse(
      (() => {
        try {
          return JSON.parse(new TextDecoder().decode(entry('ferret-record')?.bytes ?? new Uint8Array()));
        } catch {
          return undefined;
        }
      })(),
    );
    if (!recorded.success)
      throw new RelocateRefused(400, 'the bundle’s ferret record is not a record', 'bundle_refused');
    const record = recorded.data;
    if (record.harness !== manifest.needs.harness)
      throw new RelocateRefused(400, 'the bundle says two different harnesses', 'bundle_refused');
    const conversation = entry('conversation');
    if (conversation === undefined || manifest.worktree === undefined)
      throw new RelocateRefused(409, 'a move carries a ferret’s conversation and its working tree', 'move_refused');

    // Everything that can refuse, before the first write.
    const found = await this.#evaluate(manifest.needs, request.cloneInto);
    const refusal = found.refusals[0];
    if (found.resolved === undefined || refusal !== undefined)
      throw new RelocateRefused(409, found.refusals.join('; '), 'move_refused');
    const resolved = found.resolved;
    const tag = toHex(this.deps.crypto.randomBytes(4));
    const commits = entry('worktree-commits');
    if (
      commits === undefined &&
      resolved.kind === 'found' &&
      !(await this.deps.checkout.hasCommit(resolved.repo, manifest.worktree.head))
    )
      throw new RelocateRefused(
        409,
        'this project does not have the commit the ferret was on; update the project here, then move again',
        'commit_missing',
      );
    const base = resolved.kind === 'found' ? resolved.repo : resolved.destination;
    const folder = `${base}-${slug(manifest.worktree.branch ?? 'detached')}-${tag}`;
    if (!(await this.deps.checkout.isFree(folder)))
      throw new RelocateRefused(
        409,
        'the folder for the moved working tree is already taken; try again',
        'folder_taken',
      );

    const undo: (() => Promise<void>)[] = [];
    // Once a start has made the ferret nothing under it is taken back: it exists and runs on these files.
    let ferretExists = false;
    const rollback = async (): Promise<void> => {
      for (const step of undo.reverse())
        await step().catch(() => this.deps.log.warn('a moved import could not take a step back'));
    };
    try {
      let repo: string;
      if (resolved.kind === 'found') repo = resolved.repo;
      else {
        const projects = this.deps.projects();
        if (projects === undefined)
          throw new RelocateRefused(409, 'Projects is off here, so the project cannot be cloned', 'move_refused');
        // A clone makes a folder before it can fail, and the folder was free: whatever is there afterwards is ours.
        undo.push(async () => await this.deps.checkout.removeFolder(resolved.destination));
        const registered = await projects.register({ kind: 'clone', url: resolved.url, path: resolved.destination });
        if (!registered.ok) throw new RelocateRefused(409, registered.error.message, 'clone_failed');
        undo.push(async () => void (await projects.remove(registered.value.id)));
        repo = registered.value.path;
      }
      const ref = `refs/fy-relocate/${tag}`;
      if (commits === undefined) {
        if (!(await this.deps.checkout.hasCommit(repo, manifest.worktree.head)))
          throw new RelocateRefused(
            409,
            'the cloned project does not have the commit the ferret was on',
            'commit_missing',
          );
      } else {
        undo.push(async () => await this.deps.checkout.deleteRef(repo, ref));
        await this.#step(() =>
          this.deps.checkout.importCommits(repo, commits.bytes, manifest.worktree?.head ?? '', ref),
        );
      }
      const wanted = manifest.worktree.branch;
      const branch =
        wanted === undefined
          ? undefined
          : (await this.deps.checkout.branchExists(repo, wanted))
            ? `${wanted}-moved-${tag}`
            : wanted;
      undo.push(async () => {
        await this.deps.checkout.removeWorktree(repo, folder);
        if (branch !== undefined) await this.deps.checkout.deleteBranch(repo, branch);
      });
      await this.#step(() =>
        this.deps.checkout.addWorktree(repo, folder, {
          head: manifest.worktree?.head ?? '',
          ...(branch === undefined ? {} : { branch }),
        }),
      );
      await this.deps.checkout.deleteRef(repo, ref).catch(() => undefined);
      const changes = entry('worktree-changes');
      if (changes !== undefined) await this.#step(() => this.deps.checkout.applyDiff(folder, changes.bytes));
      for (const file of bundle.entries)
        if (file.kind === 'worktree-file')
          await this.#step(() => this.deps.checkout.writeNewFile(folder, file.path, file.bytes));

      const started = await this.deps.ferrets.start(
        this.#startRequest(record, found.runtime, folder, { bytes: conversation.bytes, relPath: conversation.path }),
        { kind: 'person' },
      );
      if (!started.ok) throw new RelocateRefused(409, started.error.reason, 'start_refused');
      ferretExists = true;
      const movedFrom = { daemonId: request.header.sourceDaemonId, ferretId: manifest.ferret.id };
      try {
        await this.deps.received.record(started.value, { ...movedFrom, at: this.deps.clock.now() });
      } catch {
        // The ferret exists and runs: take nothing from under it. Stop it and say the provenance was not kept.
        await this.deps.ferrets
          .stop(started.value, 'polite', 'the move could not record where it came from')
          .catch(() => undefined);
        throw new RelocateRefused(
          409,
          'the ferret was received but where it came from could not be recorded; it was stopped and kept',
          'provenance_unrecorded',
        );
      }
      return { ferretId: started.value, folder, movedFrom };
    } catch (error) {
      if (!ferretExists) await rollback();
      if (error instanceof RelocateRefused) throw error;
      throw new RelocateRefused(409, sentence(error, 'the move could not be received'), 'move_failed');
    }
  }

  #startRequest(
    record: z.infer<typeof RecordSchema>,
    runtime: string | undefined,
    folder: string,
    packed: { readonly bytes: Uint8Array; readonly relPath: string },
  ): StartRequest {
    return {
      name: record.name,
      harness: record.harness as HarnessKey,
      ...(runtime === undefined ? {} : { runtime }),
      folder,
      by: 'owner',
      relocated: packed,
      options: {
        teammateFallback: true,
        ...(record.mode === undefined ? {} : { mode: record.mode }),
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.effort === undefined ? {} : { effort: record.effort }),
        ...(record.fast === undefined ? {} : { fast: record.fast }),
        ...(record.title === undefined ? {} : { title: record.title }),
      },
    };
  }

  /** A git or file step: whatever it throws is one plain sentence of ours, never git's own text. */
  async #step(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      throw new RelocateRefused(409, sentence(error, 'the moved working tree could not be made'), 'move_failed');
    }
  }

  #guarded<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      throw error instanceof OfferError ? new RelocateRefused(error.status, error.message, error.code) : error;
    }
  }

  /** Reads only: what this machine has, and what it lacks, for a ferret that needs `needs`. */
  async #evaluate(needs: Needs, cloneInto: string | undefined): Promise<Evaluation> {
    const refusals: string[] = [];
    let project: TargetPreflightResponse['project'] = 'none';
    let resolved: Resolved | undefined;
    if (!this.deps.ferrets.harnesses().includes(needs.harness as HarnessKey))
      refusals.push(`the ${needs.harness} harness is not installed on this machine`);

    if (needs.remote === undefined)
      refusals.push('this ferret’s folder has no remote the other machine could match, so it cannot be moved');
    else {
      const projects = this.deps.projects();
      if (projects === undefined)
        refusals.push('Projects is off on this machine, so the ferret’s project cannot be found');
      else {
        const registered = await projects.list();
        for (const candidate of registered) {
          const repo = (candidate.repos ?? []).find(each => each.remote === needs.remote);
          if (repo !== undefined && resolved === undefined)
            resolved = { kind: 'found', repo: joinPath(candidate.path, repo.path) };
        }
        if (resolved !== undefined) project = 'found';
        else {
          const accounts = await (this.deps.gitAccounts()?.list() ?? Promise.resolve([]));
          const name = cloneFolderName(needs.remote);
          if (accounts.length === 0)
            refusals.push('no project here has this remote and this machine has no git account to clone it with');
          else if (cloneInto === undefined)
            refusals.push('no project here has this remote: choose a folder to clone it into');
          else if (name === null) refusals.push('the project’s address names no repository to clone');
          else if (!(await this.deps.checkout.isFree(joinPath(cloneInto, name))))
            refusals.push(`${joinPath(cloneInto, name)} already exists, so the project cannot be cloned there`);
          else {
            project = 'clone';
            resolved = { kind: 'clone', url: needs.remote, destination: joinPath(cloneInto, name) };
          }
        }
      }
    }

    let runtime: string | undefined;
    const runtimes = this.deps.runtimes();
    if (runtimes === undefined)
      refusals.push('Runtimes is off on this machine, so there is no login to run the ferret on');
    else {
      const wanted =
        needs.runtime === undefined ? undefined : await runtimes.resolve(needs.runtime as never, needs.harness);
      const own =
        wanted?.ok === true && wanted.runtime.harness === needs.harness
          ? wanted
          : await runtimes.resolve(undefined, needs.harness);
      if (own.ok && own.runtime.harness === needs.harness && own.runtime.launch.available) runtime = own.runtime.id;
      else
        refusals.push(
          `this machine has no ${needs.harness} login that can start a ferret${own.ok ? '' : `: ${own.sentence}`}`,
        );
    }

    const missingSecrets: string[] = [];
    if (needs.secrets.length > 0) {
      const vault = this.deps.vault();
      if (vault === undefined) missingSecrets.push(...needs.secrets);
      else for (const name of needs.secrets) if (!(await vault.has(name as never))) missingSecrets.push(name);
      if (missingSecrets.length > 0)
        refusals.push(
          `this machine does not hold the secret${missingSecrets.length === 1 ? '' : 's'} ${missingSecrets.join(', ')}; copy ${missingSecrets.length === 1 ? 'it' : 'them'} first`,
        );
    }
    return {
      refusals,
      project,
      ...(resolved === undefined ? {} : { resolved }),
      ...(runtime === undefined ? {} : { runtime }),
      missingSecrets,
    };
  }
}
