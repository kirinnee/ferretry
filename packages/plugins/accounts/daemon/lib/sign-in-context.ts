/**
 * WHO IS ASKING, for the order of a sign-in card and an `account_hint` (`chosenSignIn`): the calling session's board
 * project, its folder when it works on the Unfiled board, and the defaults the owner set.
 *
 * Every part comes from what the DAEMON knows about the session — its stamped board and its recorded working
 * directory — never from a field the ferret sends, so a ferret cannot ask for another project's default. A caller with
 * no session (the owner's shell) has no project and no folder, only the site lines. A part that cannot be read is
 * left out: the card then falls to the next rule and is never lost to it. Nothing here chooses or types anything;
 * the answer only orders buttons among the sign-ins the daemon matched.
 */
import type { AccountDefaultsFile, SignInChoiceContext } from '../../contract/routes/index.ts';

/** A board project's id; the Unfiled board is {@link UNFILED_PROJECT_ID}. */
export type BoardProjectId = string;
/** The board every session outside a registered project works on. */
export const UNFILED_PROJECT_ID = 'unfiled';
/** A registered project, as the order needs it: its id and its name. */
export interface ProjectInfo {
  readonly id: BoardProjectId;
  readonly name: string;
}
/** A session's recorded facts: the folder it was started in, as a real path. */
export interface SessionProjectFactSource {
  read(sessionId: string): Promise<{ readonly cwd: string } | null>;
}

/** What a choice is ordered by, without the ferret's own hint (that one is the caller's). */
export type SessionChoiceContext = Omit<SignInChoiceContext, 'hint'>;

export interface SessionSignInContextDeps {
  /** The lines in effect (`AccountDefaults.current`). */
  readonly defaults: () => Promise<AccountDefaultsFile>;
  /** The board a session works on: its stamped project, else resolved from its folder; `unfiled` when the Board says it has none, `undefined` when the Board cannot say (site lines only). */
  readonly projectOf: (sessionId: string) => Promise<BoardProjectId | undefined>;
  /** The registered projects, to name the project and tell whether its name is unique. */
  readonly projects: () => Promise<readonly ProjectInfo[]>;
  /** The session's recorded facts (its working directory). */
  readonly sessions: SessionProjectFactSource;
  /** The owner's home folder as the OS reports it (`kernel.paths.home()`), which a `~/…` folder line expands against. */
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

  /**
   * The folder the session was started in, and the home a `~` line expands against; nothing if it cannot be read.
   * The folder is Ferrets' REAL path for the ferret (it answers nothing for a folder a ferret has since swapped for a
   * symlink to another folder), so it earns no folder default instead of borrowing that other folder's line; a `~`
   * line matches only a folder under the owner's real home.
   */
  private async folderOf(sessionId: string): Promise<Pick<SessionChoiceContext, 'folder' | 'home'>> {
    const facts = await this.deps.sessions.read(sessionId).catch(() => null);
    return facts === null ? {} : { folder: facts.cwd, home: this.deps.home };
  }
}
