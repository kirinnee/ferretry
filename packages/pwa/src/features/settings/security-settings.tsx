/**
 * THE SECURITY PANEL: the passkeys THIS device holds for ONE machine, the one control that adds
 * another, and the machine's security settings (`./security-settings-block.tsx`) (`docs/design/zero-trust.md` B2, B6).
 *
 * ## WHAT THE MACHINE REPORTS IS ALL THIS SHOWS
 *
 * `GET /v1/passkeys` answers id, origin and created-at, and nothing else. There is no name, no
 * last-used time and no remove route, so none is drawn: a label is derived from origin and date, and
 * there is no "Remove" button to press that would have nothing to call.
 *
 * ## A CONTROL THAT WOULD BE REFUSED IS NOT OFFERED
 *
 * "Add a passkey" appears only when the machine says registration is open (`registration !== 'closed'`)
 * and this browser can run a ceremony at all. Otherwise one sentence says why, in place of the button.
 * When this device already holds a passkey (`confirm-existing`) the button is followed by the sentence
 * that names the machine and says the add starts with a confirmation from a passkey already held.
 *
 * ## EVERY FAILURE IS ONE SENTENCE
 *
 * A dismissed sheet, a refusal by origin and a daemon refusal code each become a plain sentence through
 * `passkeyFailureSentence`; no status, error name or stack reaches the screen.
 */

import type { PasskeysView } from '@ferretry/protocol';
import { Fingerprint, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  confirmExistingSentence,
  PASSKEY_COST_SENTENCE,
  passkeyFailureSentence,
  passkeyLabel,
  registrationClosedSentence,
  registrationClosesSentence,
  unsupportedSentence,
  webAuthnSupported,
} from '../../lib/passkey-panel.ts';
import type { CredentialsPort } from '../../lib/passkeys.ts';
import { addPasskeyCeremony, browserCredentials } from '../../lib/step-up-ceremony.ts';
import { fetchPasskeys, type StepUpClient } from '../../lib/step-up-client.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { SecuritySettingsBlock } from './security-settings-block.tsx';

export type PasskeyClientFactory = (connection: DaemonConnection) => Promise<StepUpClient>;

const LOAD_FAILURE = 'This machine did not answer the list of passkeys. Reload the page, or try again in a moment.';
const REFRESH_FAILURE = 'The passkey was added, but the list could not be refreshed. Reload the page to see it.';

interface SecurityCardProps {
  readonly view: PasskeysView;
  readonly supported: boolean;
  readonly origin: string;
  readonly machine: string;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly onAdd: () => void;
}

/** The panel's content for a loaded list. Pure over its props so every state is one render. */
function SecurityCard({ view, supported, origin, machine, busy, failure, onAdd }: SecurityCardProps) {
  const headingId = useId();
  const canAdd = supported && view.registration !== 'closed';
  const closes =
    view.registration === 'first-window' || view.registration === 'reopened'
      ? registrationClosesSentence(view.registrationClosesAt)
      : null;
  return (
    <section className="kt-panel flex min-w-0 flex-col gap-2 p-panel" aria-labelledby={headingId} data-security-card="">
      <h3 id={headingId} className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
        <Fingerprint size={16} className="text-accent" aria-hidden="true" />
        Passkeys on this device
      </h3>
      <p className="m-0 text-cell leading-base text-muted" data-security-cost="">
        {PASSKEY_COST_SENTENCE}
      </p>
      {view.passkeys.length === 0 ? (
        <p className="m-0 text-cell leading-base text-muted" data-security-empty="">
          This device has no passkey for this machine yet.
        </p>
      ) : (
        <ul className="m-0 flex min-w-0 list-none flex-col p-0">
          {view.passkeys.map(passkey => (
            <li
              key={passkey.id}
              data-security-passkey={passkey.id}
              className="min-w-0 break-words border-t border-border-soft py-2 text-ui text-fg first:border-t-0"
            >
              {passkeyLabel(passkey)}
            </li>
          ))}
        </ul>
      )}
      {canAdd ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            data-security-add=""
            onClick={onAdd}
            className="kt-btn disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus size={15} aria-hidden="true" />
            Add a passkey
          </button>
          {closes === null ? null : (
            <span className="text-meta leading-base text-faint" data-security-closes="">
              {closes}
            </span>
          )}
          {view.registration === 'confirm-existing' ? (
            <span className="text-meta leading-base text-faint" data-security-confirm-existing="">
              {confirmExistingSentence(machine)}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="m-0 text-cell leading-base text-muted" data-security-unavailable="">
          {supported ? registrationClosedSentence(view.passkeys.length > 0) : unsupportedSentence(origin)}
        </p>
      )}
      {failure === null ? null : (
        <p
          role="alert"
          data-security-failure=""
          className="m-0 rounded-control border border-err-border bg-err-bg px-2 py-1 text-meta leading-base text-err"
        >
          {failure}
        </p>
      )}
    </section>
  );
}

export interface SecuritySurfaceProps {
  readonly connection: DaemonConnection;
  /** The machine's name as the person knows it; its address when none is given. */
  readonly machineName?: string;
  readonly createClient?: PasskeyClientFactory;
  /** Test seam; production uses the browser's own credential container. */
  readonly credentials?: () => CredentialsPort;
  /** Test seam; production reads the page's own origin at the moment of the press. */
  readonly origin?: () => string;
  /** Test seam; production asks the browser. */
  readonly supported?: () => boolean;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly client: StepUpClient; readonly view: PasskeysView };

/** The live panel for one machine, keyed by the caller on its daemon id. */
export function SecuritySurface({
  connection,
  machineName,
  createClient: injectedClient,
  credentials = browserCredentials,
  origin = () => window.location.origin,
  supported = webAuthnSupported,
}: SecuritySurfaceProps) {
  // The carrier-routed client unless a test or the harness hands one in: a plain-network client reaches
  // no daemon at all, because a paired browser is answered only inside its own session.
  const routedClient = useDaemonClient();
  const createClient = injectedClient ?? routedClient;
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoaded({ kind: 'loading' });
    setFailure(null);
    void createClient(connection)
      .then(async client => ({ client, view: await fetchPasskeys(client) }))
      .then(
        ({ client, view }) => {
          if (current) setLoaded({ kind: 'ready', client, view });
        },
        () => {
          if (current) setLoaded({ kind: 'failed' });
        },
      );
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const add = useCallback(async () => {
    if (loaded.kind !== 'ready') return;
    const { client } = loaded;
    const here = origin();
    setBusy(true);
    setFailure(null);
    try {
      await addPasskeyCeremony(credentials(), client, here, supported());
    } catch (reason) {
      setFailure(passkeyFailureSentence(reason, here));
      setBusy(false);
      return;
    }
    try {
      setLoaded({ kind: 'ready', client, view: await fetchPasskeys(client) });
    } catch {
      setFailure(REFRESH_FAILURE);
    }
    setBusy(false);
  }, [credentials, loaded, origin, supported]);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {loaded.kind === 'ready' ? (
        <SecurityCard
          view={loaded.view}
          supported={supported()}
          origin={origin()}
          machine={machineName ?? connection.baseUrl}
          busy={busy}
          failure={failure}
          onAdd={() => void add()}
        />
      ) : (
        <section className="kt-panel p-panel" role="status" aria-label="Passkeys" data-security-state={loaded.kind}>
          <p className="m-0 text-cell leading-base text-muted">
            {loaded.kind === 'loading' ? 'Reading the passkeys this device holds…' : LOAD_FAILURE}
          </p>
        </section>
      )}
      <SecuritySettingsBlock connection={connection} createClient={createClient} />
    </div>
  );
}
