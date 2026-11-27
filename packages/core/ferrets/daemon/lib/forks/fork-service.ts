import type { FerretId } from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import type {
  ForkedFerret,
  ForkFailure,
  ForkOptions,
  ForkPlan,
  Harness,
  HarnessKey,
  LaunchOrigin,
  StartFailure,
  StartRequest,
  TurnRef,
} from '../../../contract/index.ts';
import type { StartAdmission } from '../ferrets/service.ts';

/** What a fork reads of the ferret it forks: where it works and on what, never its conversation. */
export interface ForkSource {
  readonly name: string;
  readonly harness: HarnessKey;
  readonly runtime?: string;
  readonly login?: string;
  readonly folder: string;
}

/** The two harness members a fork uses. */
export type ForkHarness = Pick<Harness, 'fork'>;

/** The managed worktrees a fork may cut a checkout from: the daemon's own host, or none. */
export interface ForkWorktrees {
  /** Refuses a folder that is not in a Git checkout; answers where its HEAD is. */
  readonly inspect: (folder: string) => Promise<{ readonly head: string }>;
  readonly create: (request: {
    readonly sourcePath: string;
    readonly branch: string;
    readonly base: { readonly kind: 'head' };
  }) => Promise<{ readonly cwd: string; readonly worktree: { readonly path: string; readonly branch: string } }>;
}

/** Everything the fork service reaches, as the smallest functions it uses: it owns no state of its own. */
export interface ForkPorts {
  readonly source: (ferret: FerretId) => ForkSource | undefined;
  readonly mayTouch: (caller: FerretId, target: FerretId) => boolean;
  readonly harness: (key: HarnessKey) => ForkHarness | undefined;
  readonly start: (
    request: StartRequest,
    origin: LaunchOrigin,
    admission: StartAdmission,
  ) => Promise<Result<FerretId, StartFailure>>;
  /** `undefined`: this daemon hosts no managed worktrees. */
  readonly worktrees: () => ForkWorktrees | undefined;
  readonly newId: () => string;
}

const refuse = (code: Exclude<ForkFailure['code'], 'start'>, reason: string): Result<never, ForkFailure> =>
  err({ code, reason });

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One path-safe, branch-safe word from a ferret's name. */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'ferret';

/**
 * Forking a ferret's conversation into a NEW ferret.
 *
 * The harness cuts the source conversation at a turn into a new conversation in its own history (`Harness.fork`); Ferrets
 * then starts a new ferret on that conversation, as a conversation import does. The source is only ever READ: its record,
 * its home and its conversation are not written, so a refusal at any step leaves it as it was. Every refusal that can be
 * made before the cut is made before it (the harness, the caller, the checkout), so the only thing a failed start leaves
 * behind is the cut itself, which the harness is asked to remove, and a checkout it made, which is named and left in place
 * (a worktree is never removed unasked).
 */
export class ForkService {
  constructor(private readonly ports: ForkPorts) {}

  async fork(
    from: FerretId,
    at: TurnRef,
    options: ForkOptions,
    caller: LaunchOrigin,
  ): Promise<Result<ForkedFerret, ForkFailure>> {
    const source = this.ports.source(from);
    if (source === undefined) return refuse('no_ferret', `there is no ferret ${from} to fork`);
    if (caller.kind !== 'person' && !(caller.kind === 'agent' && this.mayAct(caller.ferret, from)))
      return refuse('forbidden', 'a ferret forks only itself and its helpers');
    const harness = this.ports.harness(source.harness);
    if (harness?.fork === undefined)
      return refuse(
        'unsupported',
        `the ${source.harness} harness cannot fork a conversation yet, so nothing was forked and nothing was written`,
      );

    let folder = source.folder;
    let checkout: ForkedFerret['worktree'];
    if (options.worktree === 'new') {
      const made = await this.checkout(source);
      if (!made.ok) return made;
      folder = made.value.cwd;
      checkout = made.value.worktree;
    }

    let plan: ForkPlan;
    try {
      plan = await harness.fork(from, at, { folder });
    } catch (error) {
      return refuse('cut', `the conversation could not be cut: ${messageOf(error)}${this.left(checkout)}`);
    }

    const started = await this.ports
      .start(
        {
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(caller.kind === 'agent' ? { parent: from } : {}),
          harness: source.harness,
          ...(source.runtime === undefined ? {} : { runtime: source.runtime }),
          ...(source.login === undefined ? {} : { login: source.login }),
          folder,
          harnessConversation: plan.harnessConversation,
          by: caller.kind === 'agent' ? 'ferret' : 'owner',
        },
        caller,
        // The cut is already in the harness's history: there is nothing to stage from the owner's own computer.
        { conversationInPool: true },
      )
      .catch((error: unknown) => err<StartFailure>({ code: 'failed', reason: messageOf(error) }));
    if (!started.ok) {
      // Remove the conversation this fork wrote, and nothing else. A harness that cannot leaves it unreferenced.
      await plan.discard?.().catch(() => undefined);
      return err({ code: 'start', reason: `${started.error.reason}${this.left(checkout)}`, start: started.error });
    }
    return ok({
      ferret: started.value,
      harnessConversation: plan.harnessConversation,
      folder,
      ...(checkout === undefined ? {} : { worktree: checkout }),
    });
  }

  /** A ferret reaches only itself and its helpers; an agent that names no ferret reaches nothing. */
  private mayAct(caller: FerretId | undefined, target: FerretId): boolean {
    return caller !== undefined && this.ports.mayTouch(caller, target);
  }

  /** A new checkout cut from the source's own HEAD. Every failure here is before the cut. */
  private async checkout(
    source: ForkSource,
  ): Promise<Result<NonNullable<Awaited<ReturnType<ForkWorktrees['create']>>>, ForkFailure>> {
    const worktrees = this.ports.worktrees();
    if (worktrees === undefined)
      return refuse('worktree', 'this daemon hosts no managed worktrees, so the fork cannot work in a new one');
    try {
      await worktrees.inspect(source.folder);
    } catch (error) {
      return refuse(
        'worktree',
        `${source.folder} is not in a Git checkout, so the fork cannot work in a new worktree (${messageOf(error)})`,
      );
    }
    try {
      return ok(
        await worktrees.create({
          sourcePath: source.folder,
          branch: `fork/${slug(source.name)}-${this.ports.newId().slice(0, 8)}`,
          base: { kind: 'head' },
        }),
      );
    } catch (error) {
      return refuse('worktree', `the new worktree could not be made: ${messageOf(error)}`);
    }
  }

  private left(checkout: ForkedFerret['worktree']): string {
    return checkout === undefined
      ? ''
      : `. The new worktree ${checkout.path} was left in place; remove it with fy worktree remove if you do not want it`;
  }
}
