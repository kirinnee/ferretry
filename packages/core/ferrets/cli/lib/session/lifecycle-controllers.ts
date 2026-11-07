import type { ISessionApi } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

/** Interrupts the active turn: `fy interrupt`. */
export class InterruptSessionController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(id: string, flags: { json?: boolean } = {}): Promise<void> {
    this.presenter.view(await this.api.interrupt(id), flags.json === true);
  }
}

/** Revives a stopped or dead session with its conversation intact: `fy resume`. */
export class ResumeSessionController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(id: string, flags: { message?: string; json?: boolean } = {}): Promise<void> {
    const message = flags.message?.trim();
    const view = await this.api.resume(id, message === undefined || message === '' ? undefined : message);
    this.presenter.view(view, flags.json === true);
  }
}
