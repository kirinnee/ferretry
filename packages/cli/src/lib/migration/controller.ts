import type { SessionPresenter } from '../session/presenter.ts';
import type { IMigrationGateway } from './ports.ts';

/** Flags accepted by `fy migrate`. */
export interface MigrationCommandOptions {
  readonly agent: string;
  readonly model?: string;
  readonly allowContextDowngrade?: boolean;
  readonly requestId?: string;
  readonly json?: boolean;
}

/** Moves one session to another account through the daemon's mandatory preflight gate. */
export class MigrationController {
  constructor(
    private readonly gateway: IMigrationGateway,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(reference: string, options: MigrationCommandOptions): Promise<void> {
    const id = reference.trim();
    if (id === '') throw new Error('a session id or callsign is required');
    const agent = options.agent.trim();
    if (agent === '') throw new Error('--agent must name a fleet account');
    const model = optionalText(options.model);
    const requestId = optionalText(options.requestId);
    if (options.requestId !== undefined && requestId === undefined) throw new Error('--request-id must not be blank');

    const view = await this.gateway.migrate(id, agent, model, options.allowContextDowngrade === true, requestId);
    this.presenter.view(view, options.json === true);
  }
}

/** Trims an optional CLI value, treating blank optional text as absent. */
function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
