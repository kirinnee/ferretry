import { type CompactAt, describeCompactAt, parseCompactAt } from '../../../daemon/lib/protocol/compact-at.ts';
import { SessionCommandError } from './errors.ts';
import type { SessionPresenter } from './presenter.ts';

/** What `GET /v1/ferrets/:ferretId/compact-at` answers: the value in effect, the ferret's own, and why. */
export interface SessionCompactAt {
  readonly effective: CompactAt;
  readonly own?: CompactAt;
  readonly note: string;
}

/** The change `PATCH /v1/ferrets/:ferretId/compact-at` takes: a value, or `inherit` to drop the ferret's own. */
export interface SessionCompactAtPatch {
  readonly compactAt: CompactAt | 'inherit';
}

/** What setting it did, as the daemon said it. */
export interface CompactAtChange {
  readonly view?: unknown;
  readonly note: string;
  readonly restartRequired: boolean;
}

/** The two routes `fy session compact-at` speaks. */
export interface ISessionCompactAtGateway {
  read(session: string): Promise<SessionCompactAt>;
  write(session: string, change: SessionCompactAtPatch): Promise<CompactAtChange>;
}

/**
 * Reads or sets where one ferret compacts its conversation: `fy session compact-at <ferret> [tokens|auto|inherit]`.
 *
 * With no value it reads. A value is `auto` (the harness's own trigger), a size like `250k` or `250000`, or
 * `inherit` (drop this ferret's own value so its login's default applies again). A running ferret takes a change at
 * its next restart, and the answer says so.
 */
export class SessionCompactAtController {
  constructor(
    private readonly gateway: ISessionCompactAtGateway,
    private readonly presenter: SessionPresenter,
  ) {}

  async run(reference: string, value: string | undefined, flags: { readonly json?: boolean } = {}): Promise<void> {
    const session = reference.trim();
    if (session === '') throw new SessionCommandError('name the ferret to change');
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
