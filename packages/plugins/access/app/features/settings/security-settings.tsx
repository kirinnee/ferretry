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
 * `passkeyFailureSentence`; no status or stack reaches the screen, and a browser's own error ends the sentence by name and message.
 */

import { Loading } from '@ferretry/app/ui';
import type { PasskeysView } from '../../../contract/index.ts';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  confirmExistingSentence,
  PASSKEY_COST_SENTENCE,
  passkeyFailureSentence,
  passkeyLabel,
  NO_WINDOW_SENTENCE,
  passkeyWindowCommand,
  registrationClosedSentence,
  registrationClosesSentence,
  unsupportedSentence,
  webAuthnSupported,
} from '../../lib/passkey-panel.ts';
import type { CredentialsPort } from '@ferretry/app';
import { addPasskeyCeremony, browserCredentials } from '../../lib/step-up-ceremony.ts';
import { fetchPasskeys, type StepUpClient } from '../../lib/step-up-client.ts';
import { type DaemonConnection, useDaemonClient } from '../../shell-grants.ts';
import { OwnerCommand } from '../step-up/step-up-dialog.tsx';
import { SecuritySettingsBlock } from './security-settings-block.tsx';

export type PasskeyClientFactory = (connection: DaemonConnection) => Promise<StepUpClient>;

import { SettingGroup, SettingRow } from '@ferretry/app';
import { AccessTab, Notice } from './access-kit.tsx';

const LOAD_FAILURE = 'This machine did not answer the list of passkeys. Reload the page, or try again in a moment.';
const REFRESH_FAILURE = 'The passkey was added, but the list could not be refreshed. Reload the page to see it.';

interface SecurityCardProps {
  readonly view: PasskeysView;
  readonly supported: boolean;
  readonly origin: string;
  readonly machine: string;
  /** This device's id, for the owner's command when the machine did not send its name. */
  readonly deviceId: string;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly onAdd: () => void;
}

/** The panel's content for a loaded list. Pure over its props so every state is one render. */
function SecurityCard({ view, supported, origin, machine, deviceId, busy, failure, onAdd }: SecurityCardProps) {
  const windowCommand = passkeyWindowCommand({
    ...(view.deviceName === undefined ? {} : { name: view.deviceName }),
    id: deviceId,
    ...(view.clientName === undefined ? {} : { clientName: view.clientName }),
  });
  const canAdd = supported && view.registration !== 'closed';
  const closes =
    view.registration === 'first-window' || view.registration === 'reopened'
      ? registrationClosesSentence(view.registrationClosesAt)
      : null;
  return (
    <div data-security-card="">
      <SettingGroup label="Passkeys on this device">
        {/* The cost, said before the button: what a passkey is for and what it does not do. */}
        <SettingRow
          name="What a passkey does here"
          hint="Asked once to unlock this machine."
          dataAttributes={{ 'data-security-cost': '' }}
        >
          <div className="fy-acc-body">
            <p className="fy-acc-fine">{PASSKEY_COST_SENTENCE}</p>
          </div>
        </SettingRow>
        {view.passkeys.length === 0 ? (
          <SettingRow
            name="No passkey yet"
            hint="This device has no passkey for this machine yet."
            dataAttributes={{ 'data-security-empty': '' }}
          />
        ) : (
          view.passkeys.map(passkey => (
            <SettingRow
              key={passkey.id}
              name={passkeyLabel(passkey)}
              dataAttributes={{ 'data-security-passkey': passkey.id }}
            />
          ))
        )}
        {canAdd ? (
          <SettingRow
            name="Add a passkey"
            hint={
              closes !== null ? (
                <span data-security-closes="">{closes}</span>
              ) : view.registration === 'confirm-existing' ? (
                <span data-security-confirm-existing="">{confirmExistingSentence(machine)}</span>
              ) : undefined
            }
            control={() => (
              <button
                type="button"
                disabled={busy}
                data-security-add=""
                onClick={onAdd}
                className="kt-btn min-h-[44px] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Plus size={15} aria-hidden="true" />
                Add a passkey
              </button>
            )}
          />
        ) : (
          <SettingRow
            name="Adding a passkey"
            hint="Not available right now."
            dataAttributes={{ 'data-security-unavailable': '' }}
          >
            <div className="fy-acc-body">
              {supported && view.passkeys.length === 0 ? (
                <>
                  <p className="fy-acc-fine">{NO_WINDOW_SENTENCE}</p>
                  <OwnerCommand command={windowCommand} />
                </>
              ) : (
                <p className="fy-acc-fine">
                  {supported ? registrationClosedSentence(true, windowCommand) : unsupportedSentence(origin)}
                </p>
              )}
            </div>
          </SettingRow>
        )}
      </SettingGroup>
      {failure === null ? null : (
        <Notice tone="err" role="alert" marks={{ 'data-security-failure': '' }}>
          {failure}
        </Notice>
      )}
    </div>
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
    <AccessTab name="security">
      {loaded.kind === 'ready' ? (
        <SecurityCard
          view={loaded.view}
          supported={supported()}
          origin={origin()}
          machine={machineName ?? connection.baseUrl}
          deviceId={connection.deviceId}
          busy={busy}
          failure={failure}
          onAdd={() => void add()}
        />
      ) : loaded.kind === 'loading' ? (
        // Nothing is drawn in place while reading (an empty bordered panel would only flash): the shell's one bar says so.
        <Loading kind="bar" label="Reading the passkeys this device holds…" />
      ) : (
        <Notice tone="warn" role="status" marks={{ 'data-security-state': loaded.kind }}>
          {LOAD_FAILURE}
        </Notice>
      )}
      <SecuritySettingsBlock connection={connection} createClient={createClient} />
    </AccessTab>
  );
}
