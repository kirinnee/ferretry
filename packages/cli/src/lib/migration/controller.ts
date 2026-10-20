import { type MigrationConversation, MigrationConversationSchema } from '@ferretry/protocol';
import type { SessionPresenter } from '../session/presenter.ts';
import type { IMigrationGateway } from './ports.ts';

/** Flags accepted by `fy migrate`. */
export interface MigrationCommandOptions {
  readonly agent: string;
  readonly model?: string;
  readonly allowContextDowngrade?: boolean;
  readonly forceInflight?: boolean;
  /** `resume` (the daemon's default), `fresh` or `previous`; see `MigrationConversation`. */
  readonly conversation?: string;
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
    const conversation = conversationChoice(options.conversation);

    const view = await this.gateway.migrate(
      id,
      agent,
      model,
      options.allowContextDowngrade === true,
      requestId,
      options.forceInflight === true,
      ...(conversation === undefined ? [] : [conversation]),
    );
    this.presenter.view(view, options.json === true);
  }
}

/** The `--conversation` choice, refused before the destructive call when it is not one the daemon knows. */
function conversationChoice(value: string | undefined): MigrationConversation | undefined {
  if (value === undefined) return undefined;
  const parsed = MigrationConversationSchema.safeParse(value.trim());
  if (!parsed.success)
    throw new Error(`--conversation must be one of ${MigrationConversationSchema.options.join(', ')}`);
  return parsed.data;
}

/** Trims an optional CLI value, treating blank optional text as absent. */
function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
