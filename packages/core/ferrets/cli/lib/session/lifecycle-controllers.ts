import type { ISessionApi } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

/** Revives a stopped ferret with its conversation intact: `fy resume`. */
export class ResumeSessionController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(id: string, flags: { message?: string; json?: boolean } = {}): Promise<void> {
    const message = flags.message?.trim();
    const resumed = await this.api.resume(id, message === undefined || message === '' ? undefined : message);
    this.presenter.view(await this.api.get(resumed.id), flags.json === true);
  }
}
