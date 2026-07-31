import type { ISessionApi } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

/** Shows one session in detail: `fy status <id>`. */
export class SessionStatusController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(id: string, flags: { json?: boolean } = {}): Promise<void> {
    this.presenter.view(await this.api.get(id), flags.json === true);
  }
}
