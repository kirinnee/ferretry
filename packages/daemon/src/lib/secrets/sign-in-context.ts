/**
 * WHO IS ASKING, for the order of a sign-in card and an `account_hint` (`chosenSignIn`): the calling session's board
 * project, its folder when it works on the Unfiled board, and the defaults the owner set.
 *
 * Every part comes from what the DAEMON knows about the session — its stamped board and its recorded working
 * directory — never from anything the ferret says, so a ferret cannot ask for another project's default. A caller with
 * no session (the owner's shell) has no project and no folder, only the site lines. A part that cannot be read is
 * left out: the card then falls to the next rule and is never lost to it. Nothing here chooses or types anything;
 * the answer only orders buttons among the sign-ins the daemon matched.
 */
import {
  type AccountDefaultsFile,
  type BoardProjectId,
  type ProjectInfo,
  type SignInChoiceContext,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import type { SessionProjectFactSource } from '../board-projects/session-projects.ts';

/** What a choice is ordered by, without the ferret's own hint (that one is the caller's). */
export type SessionChoiceContext = Omit<SignInChoiceContext, 'hint'>;

export interface SessionSignInContextDeps {
  /** The lines in effect (`AccountDefaults.current`). */
  readonly defaults: () => Promise<AccountDefaultsFile>;
  /** The board a session works on: its stamped project, else resolved from its folder; `unfiled` when it has none. */
  readonly projectOf: (sessionId: string) => Promise<BoardProjectId>;
  /** The registered projects, to name the project and tell whether its name is unique. */
  readonly projects: () => Promise<readonly ProjectInfo[]>;
  /** The session's recorded facts (its working directory). */
  readonly sessions: SessionProjectFactSource;
  /** The real path of a folder (symlinks resolved), or `undefined` when it cannot be resolved. */
  readonly realpath: (path: string) => Promise<string | undefined>;
  /** The owner's home folder, which a `~/…` folder line expands against. */
  readonly home: string;
}

/** What a consumer asks: the order for one calling session (absent: the owner's own request). */
export interface SignInChoicePort {
  of(sessionId: string | undefined): Promise<SessionChoiceContext>;
}

export class SessionSignInContext implements SignInChoicePort {
  constructor(private readonly deps: SessionSignInContextDeps) {}

  /** The context for `sessionId` (absent: the owner's own request), or the site lines alone when nothing else is known. */
  async of(sessionId: string | undefined): Promise<SessionChoiceContext> {
    const defaults = await this.deps.defaults().catch((): AccountDefaultsFile => ({}));
    if (sessionId === undefined) return { defaults };
    const board = await this.deps.projectOf(sessionId).catch(() => undefined);
    if (board === undefined) return { defaults };
    if (board === UNFILED_PROJECT_ID) return { defaults, ...(await this.folderOf(sessionId)) };
    const projects = await this.deps.projects().catch((): readonly ProjectInfo[] => []);
    const project = projects.find(each => each.id === board);
    if (project === undefined) return { defaults };
    return {
      defaults,
      project: {
        id: project.id,
        name: project.name,
        nameIsUnique: projects.filter(each => each.name === project.name).length === 1,
      },
    };
  }

  /** The real folder the session was started in, and the real home a `~` line expands against; nothing if either fails. */
  private async folderOf(sessionId: string): Promise<Pick<SessionChoiceContext, 'folder' | 'home'>> {
    const facts = await this.deps.sessions.read(sessionId).catch(() => null);
    if (facts === null) return {};
    const [folder, home] = await Promise.all([
      this.deps.realpath(facts.cwd).catch(() => undefined),
      this.deps.realpath(this.deps.home).catch(() => undefined),
    ]);
    return folder === undefined ? {} : { folder, home: home ?? this.deps.home };
  }
}
