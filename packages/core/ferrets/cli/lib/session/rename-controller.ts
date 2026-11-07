import type { FerretSummary } from '../../../contract/index.ts';
import { FerretNameSchema } from '../../../contract/index.ts';
import { displayName } from './display.ts';
import { SessionCommandError } from './errors.ts';
import type { ISessionApi } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

/** Flags accepted by `fy rename`. */
export interface RenameFlags {
  /** A new task title, alongside or instead of a new first name. */
  readonly title?: string;
  readonly json?: boolean;
}

/**
 * Renames a ferret: `fy rename <ferret> [name] [--title <title>]`.
 *
 * The ferret may be named by its id or by its current first name, in any case — the way a person refers to an agent.
 * The DAEMON reads the name, as it does for every per-ferret route, so a name two ferrets hold is refused there with
 * both ids. The new first name is checked against the same grammar the daemon enforces before anything is sent, and
 * the daemon then CLAIMS it: a name another ferret holds is refused there, in plain words, never silently replaced.
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
    let name: string | undefined;
    if (requested !== undefined && requested !== '') {
      const parsed = FerretNameSchema.safeParse(requested);
      if (!parsed.success) throw new SessionCommandError(parsed.error.issues[0]?.message ?? 'that name is not usable');
      name = parsed.data;
    }
    const view = await this.api.rename(reference.trim(), {
      ...(name === undefined ? {} : { name }),
      ...(title === undefined || title === '' ? {} : { title }),
    });
    if (flags.json === true) {
      this.presenter.json(view);
      return;
    }
    this.presenter.lines([`renamed ${view.id}: ${describe(view)}`]);
  }
}

function describe(view: FerretSummary): string {
  return view.title === undefined ? displayName(view.name) : `${displayName(view.name)} — ${view.title}`;
}
