/**
 * SETTINGS › BUDGETS: every login on this machine with its spend budget — where it stands and a place to set it.
 *
 * The logins are Logins' (`GET /v1/logins`), the standing against each budget is Usage's own
 * (`GET /v1/usage/budgets`, which replaces the budget a credential list used to carry), and a save writes
 * `usage.yaml` through the checked configuration write (see `budget-editor.tsx`). A login that reads back no
 * standing yet shows the editor without a meter: unknown is never a zero.
 */

import { type LoginList, LoginListSchema } from '@ferretry/plugin-logins/contract';
import { useCallback, useEffect, useState } from 'react';
import { type BudgetsView, BudgetsViewSchema } from '../../../contract/index.ts';
import type { DaemonConnection, UsageClient } from '../../shell.ts';
import { BudgetEditor } from './budget-editor.tsx';

type BudgetsState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly logins: LoginList; readonly standing: BudgetsView };

const failureWords = (cause: unknown): string =>
  cause instanceof Error && cause.message.trim() !== '' ? cause.message : 'The daemon did not answer this request.';

export interface BudgetsSettingsProps {
  readonly connection: DaemonConnection;
  /** This daemon's client; the logins, their standing and the file are read through it. */
  readonly client: UsageClient;
  /** Supplied in tests; the zone this device reports, written to usage.yaml on a first save. */
  readonly deviceTimeZone?: string;
}

export function BudgetsSettings({ connection, client, deviceTimeZone }: BudgetsSettingsProps) {
  const [state, setState] = useState<BudgetsState>({ status: 'loading' });

  const read = useCallback(async (): Promise<BudgetsState> => {
    try {
      const [logins, standing] = await Promise.all([
        client.call('GET /v1/logins').then(answer => LoginListSchema.parse(answer)),
        client.call('GET /v1/usage/budgets').then(answer => BudgetsViewSchema.parse(answer)),
      ]);
      return { status: 'ready', logins, standing };
    } catch (cause) {
      return { status: 'failed', message: failureWords(cause) };
    }
  }, [client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different daemon starts the read over
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    void read().then(next => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [connection.daemonId, read]);

  const reload = useCallback(async (): Promise<void> => {
    setState(await read());
  }, [read]);

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-labelledby="budgets-settings-heading"
      data-budgets-daemon={connection.daemonId}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id="budgets-settings-heading" className="m-0 text-row font-semibold text-fg">
          Budgets
        </h3>
        <p className="m-0 text-cell leading-base text-muted">
          A cap on what each login may spend here. Past its trigger nothing new starts on the login; past its hard limit
          its ferrets are stopped.
        </p>
      </div>
      {state.status === 'loading' ? (
        <p role="status" className="m-0 text-cell text-muted">
          Reading budgets…
        </p>
      ) : null}
      {state.status === 'failed' ? (
        <p role="alert" className="m-0 text-cell text-err" data-budgets-failed="">
          Budgets could not load: {state.message}
        </p>
      ) : null}
      {state.status === 'ready' && state.logins.logins.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-budgets-empty="">
          No logins yet, so nothing to cap.
        </p>
      ) : null}
      {state.status === 'ready'
        ? state.logins.logins.map(login => (
            <div key={login.id} className="flex min-w-0 flex-col gap-1" data-budgets-login={login.id}>
              <h4 className="m-0 text-ui font-semibold text-fg">{login.label ?? login.email ?? login.id}</h4>
              <BudgetEditor
                credential={{
                  id: login.id,
                  budget: state.standing.budgets.find(entry => entry.login === login.id)?.budget ?? login.budget,
                }}
                machineName={state.logins.machine}
                online
                client={client}
                onChanged={reload}
                {...(deviceTimeZone === undefined ? {} : { deviceTimeZone })}
              />
            </div>
          ))
        : null}
    </section>
  );
}
