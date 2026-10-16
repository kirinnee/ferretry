import { AgentNameSchema, type SessionView } from '@ferretry/protocol';
import { SessionCommandError } from './errors.ts';
import type { ISessionApi } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

/** Flags accepted by `fy rename`. */
export interface RenameFlags {
  /** A new task title, alongside or instead of a new first name. */
  readonly title?: string;
  readonly json?: boolean;
}

/** `hadi` → `Hadi`, `mary-jane` → `Mary-Jane`: how every surface shows a first name. */
function displayName(callsign: string): string {
  return callsign
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

/**
 * Renames an agent: `fy rename <session> [name] [--title <title>]`.
 *
 * The session may be named by its id or by its current first name, in any case — the way a person
 * refers to an agent. The new first name is checked against the same grammar the daemon enforces
 * before anything is sent, and the daemon then CLAIMS it: a name another agent on this machine holds
 * is refused there, in plain words, and is never silently replaced.
 */
export class RenameSessionController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(reference: string, nameValue: string | undefined, flags: RenameFlags = {}): Promise<void> {
    const title = flags.title?.trim();
    const requested = nameValue?.trim();
    if ((requested === undefined || requested === '') && (title === undefined || title === ''))
      throw new SessionCommandError('give a new name, a new --title, or both');
    let teammate: string | undefined;
    if (requested !== undefined && requested !== '') {
      const parsed = AgentNameSchema.safeParse(requested);
      if (!parsed.success) throw new SessionCommandError(parsed.error.issues[0]?.message ?? 'that name is not usable');
      teammate = parsed.data;
    }
    const id = await this.resolve(reference.trim());
    const view = await this.api.rename(id, title === '' ? undefined : title, teammate);
    if (flags.json === true) {
      this.presenter.json(view);
      return;
    }
    this.presenter.lines([`renamed ${view.config.id}: ${describe(view)}`]);
  }

  /**
   * The session id a reference names: an id as itself, or the one agent answering to a first name.
   *
   * Live agents never share a first name, but an ended one can still carry a name a newer agent has
   * since taken — so a first name matching more than one session is refused with the ids, rather than
   * renaming whichever happened to be listed first.
   */
  private async resolve(reference: string): Promise<string> {
    const sessions = await this.api.list();
    if (sessions.some(view => view.config.id === reference)) return reference;
    const wanted = reference.toLowerCase();
    const named = sessions.filter(view => view.config.teammate?.toLowerCase() === wanted);
    if (named.length > 1)
      throw new SessionCommandError(
        `${displayName(wanted)} names ${named.length} sessions (${named.map(view => view.config.id).join(', ')}); rename by id`,
      );
    return named[0]?.config.id ?? reference;
  }
}

function describe(view: SessionView): string {
  const teammate = view.config.teammate;
  return teammate === undefined ? view.config.name : `${displayName(teammate)} — ${view.config.name}`;
}
