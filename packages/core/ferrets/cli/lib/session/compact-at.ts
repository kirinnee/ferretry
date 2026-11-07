import {
  describeCompactAt,
  type IFyApiClient,
  parseCompactAt,
  type SessionCompactAt,
  type SessionCompactAtPatch,
  SessionCompactAtPatchResultSchema,
  SessionCompactAtPatchSchema,
  SessionCompactAtSchema,
  type SessionView,
} from '@ferretry/protocol';
import type { Command } from 'commander';
import { SessionCommandError } from './errors.ts';
import type { SessionPresenter } from './presenter.ts';

/** What setting it did, as the daemon said it. */
export interface CompactAtChange {
  readonly view: SessionView;
  readonly note: string;
  readonly restartRequired: boolean;
}

/** The two routes `fy session compact-at` speaks. */
export interface ISessionCompactAtGateway {
  read(session: string): Promise<SessionCompactAt>;
  write(session: string, change: SessionCompactAtPatch): Promise<CompactAtChange>;
}

const compactAtPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/compact-at`;

/** Speaks them through the protocol client; the session may be named by id or first name, and both answers are parsed. */
export class ProtocolSessionCompactAtGateway implements ISessionCompactAtGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request' | 'get'>) {}

  async read(session: string): Promise<SessionCompactAt> {
    const { config } = await this.client.get(session);
    return await this.client.request(compactAtPath(config.id), SessionCompactAtSchema);
  }

  async write(session: string, change: SessionCompactAtPatch): Promise<CompactAtChange> {
    const { config } = await this.client.get(session);
    const body = SessionCompactAtPatchSchema.parse(change);
    const { view, restartRequired, note } = await this.client.request(
      compactAtPath(config.id),
      SessionCompactAtPatchResultSchema,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    return { view, restartRequired, note };
  }
}

/**
 * Reads or sets where one ferret compacts its conversation: `fy session compact-at <session> [tokens|auto|inherit]`.
 *
 * With no value it reads. A value is `auto` (the harness's own trigger), a size like `250k` or `250000`, or
 * `inherit` (drop this ferret's own value so its login's default applies again). A running ferret takes a change
 * at its next restart, and the answer says so.
 */
export class SessionCompactAtController {
  constructor(
    private readonly gateway: ISessionCompactAtGateway,
    private readonly presenter: SessionPresenter,
  ) {}

  async run(reference: string, value: string | undefined, flags: { readonly json?: boolean } = {}): Promise<void> {
    const session = reference.trim();
    if (session === '') throw new SessionCommandError('name the session to change');
    if (value === undefined) {
      const reading = await this.gateway.read(session);
      if (flags.json === true) this.presenter.json(reading);
      else
        this.presenter.lines([
          `compact at ${describeCompactAt(reading.effective)}${reading.own === undefined ? ' (default)' : ''}`,
          reading.note,
        ]);
      return;
    }
    const change = await this.gateway.write(session, { compactAt: wantedOf(value) });
    if (flags.json === true) this.presenter.json(change);
    else this.presenter.lines([change.note]);
  }
}

function wantedOf(value: string): SessionCompactAtPatch['compactAt'] {
  if (value.trim().toLowerCase() === 'inherit') return 'inherit';
  const parsed = parseCompactAt(value);
  if (!parsed.ok) throw new SessionCommandError(parsed.reason);
  return parsed.value;
}

/** `fy session compact-at <session> [value] [--json]`. Wiring only; the controller decides. */
export function registerSessionCompactAtCommand(
  program: Command,
  controller: SessionCompactAtController,
  presenter: SessionPresenter,
): void {
  const session =
    program.commands.find(command => command.name() === 'session') ??
    program.command('session').description("act on a session's own standing with this daemon");
  session
    .command('compact-at')
    .description('show or set where a ferret squeezes its conversation (a size like 250k, auto, or inherit)')
    .argument('<session>', 'session id or first name')
    .argument('[value]', 'tokens (250k, 250000), auto, or inherit; omit to show the current value')
    .option('--json', 'print the answer as JSON')
    .action(async (reference: string, value: string | undefined, options: { readonly json?: boolean }) => {
      try {
        await controller.run(reference, value, options.json === true ? { json: true } : {});
      } catch (error) {
        presenter.fail(error);
      }
    });
}
