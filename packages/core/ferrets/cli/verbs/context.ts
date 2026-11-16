import type { CliContext, VerbHandler, VerbInvocation, VerbsOf } from '@ferretry/kernel/manifest';
import type manifest from '../../manifest.ts';
import { ClientSessionApi } from '../lib/client.ts';
import { SessionCommandError } from '../lib/session/errors.ts';
import type { SessionEnvironment } from '../lib/session/ports.ts';
import { SessionPresenter } from '../lib/session/presenter.ts';
import { guarded, on, VerbIo } from '../lib/verb-io.ts';

/** The binary's name, for sentences that name a command. */
export const BINARY = 'fy';

/** Every verb Ferrets' manifest declares, as it is spelled there (`'fs ls <id> [path]'`). */
export type FerretsVerb = VerbsOf<typeof manifest>;

/** One handler's body: what the verb does, with the presenter and the I/O `verb()` builds around it. */
type Work = (invocation: VerbInvocation, presenter: SessionPresenter, io: VerbIo) => Promise<void>;

/**
 * What the shell hands a CLI half, plus the pieces every verb used to build for itself in `cli/index.ts`: the guarded
 * session API, the folder `fy` was typed in, and the wrapper that turns a body into an exit code.
 */
export interface VerbContext extends CliContext<typeof manifest> {
  readonly api: ClientSessionApi;
  /** The folder `fy` was typed in: the shell hands it as `PWD` (its real working directory, never a parent's stale variable). */
  readonly environment: SessionEnvironment;
  /** Wraps a body in the guarded presenter/io every verb runs under, answering the exit code. */
  readonly verb: (work: Work) => VerbHandler;
  /** `{ json: true }` when `--json` was typed, nothing otherwise. */
  readonly json: (invocation: VerbInvocation) => { json?: true };
  /** The first positional, trimmed; refuses a missing one by name. */
  readonly first: (invocation: VerbInvocation, what: string) => string;
  /** A group verb typed bare: prints its usage and exits 2. */
  readonly usage: (lines: readonly string[]) => VerbHandler;
}

export function verbContext(shell: CliContext<typeof manifest>): VerbContext {
  const verb: VerbContext['verb'] = work => async invocation => {
    const io = new VerbIo(shell.io);
    const presenter = new SessionPresenter(io);
    return await guarded(io, presenter, async () => await work(invocation, presenter, io));
  };
  return {
    ...shell,
    api: new ClientSessionApi(shell.client),
    environment: { cwd: shell.env?.PWD ?? process.cwd() },
    verb,
    json: invocation => (on(invocation, 'json') ? { json: true } : {}),
    first: (invocation, what) => {
      const value = invocation.args[0]?.trim();
      if (value === undefined || value === '') throw new SessionCommandError(`missing the ${what}`);
      return value;
    },
    usage: lines =>
      verb(async (_invocation, presenter, io) => {
        presenter.report(lines);
        io.setExitCode(2);
      }),
  };
}

/**
 * One verb file's handlers. A file default-exports `defineVerbs(c => ({ 'fs ls <id> [path]': …, … }))`: the keys are
 * checked against the manifest (a key it does not declare is a type error here), and `cli/index.ts` checks the other way
 * (a declared verb no file handles is a type error there). Two files handling one verb is refused when the half builds.
 */
export interface CliVerb<K extends string = FerretsVerb> {
  readonly build: (c: VerbContext) => { readonly [P in K]: VerbHandler };
}

export const defineVerbs = <const K extends FerretsVerb>(build: CliVerb<K>['build']): CliVerb<K> => ({ build });
