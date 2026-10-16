/**
 * Add a login › **Environment** (docs/provider-presets.md): a grid of the providers this machine offers;
 * one tap opens that provider's minimal form — just its key — and Add makes the login; then Test it.
 * **Paste variables…** recognises the provider from a block a person already has and opens the same form
 * filled in.
 *
 * A login made from a provider with a `claude:` and a `codex:` half drives both CLIs with one secret.
 * Opened for one CLI (from Add a runtime), only the providers with a half for it are offered.
 *
 * The Test runs on the SAVED login: the daemon tests a login it has, never a draft, so a Test can only
 * send a key to where that login itself sends it.
 */

import type { FleetProviderPresetView } from '@ferretry/protocol';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { listSecrets } from '../../secrets/secrets-api.ts';
import { readFleetPresets } from '../credentials-api.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import type { MachineData } from '../runtimes/machine-data.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import type { AccountChanges } from '../shell/apply-change-panel.tsx';
import type { HarnessKind } from './credentials-model.ts';
import { presetsFor } from './environment-model.ts';
import { LoginTest } from './login-test.tsx';
import { OneClickLogin } from './one-click-login.tsx';
import { PasteVariables } from './paste-variables.tsx';
import { ProviderGrid } from './provider-grid.tsx';
import type { Prefill } from './provider-model.ts';

export interface EnvironmentLoginProps {
  /** Set when the flow was opened for one harness: only presets with a half for it are offered. */
  readonly harness?: HarnessKind;
  readonly machineName: string;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly data: MachineData | null;
  readonly reload: () => Promise<MachineData | null>;
  readonly changes: AccountChanges;
  /** The login is added and the person pressed Done. */
  readonly onAdded: (credentialId: string) => void;
  /** The login is saved and its Test is on screen: the flow moves to its Test step. */
  readonly onSaved?: (credentialId: string) => void;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly sentence: string }
  | { readonly kind: 'ready'; readonly presets: readonly FleetProviderPresetView[] };

/** Which screen of the Environment path is up. */
type Screen =
  | { readonly kind: 'grid' }
  | { readonly kind: 'paste' }
  | { readonly kind: 'form'; readonly presetId: string; readonly prefill?: Prefill }
  | { readonly kind: 'added'; readonly presetId: string; readonly credentialId: string };

export function EnvironmentLogin({
  harness,
  machineName,
  connection,
  createClient,
  data,
  reload,
  changes,
  onAdded,
  onSaved,
}: EnvironmentLoginProps) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [stored, setStored] = useState<ReadonlySet<string>>(new Set());
  const [screen, setScreen] = useState<Screen>({ kind: 'grid' });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const client = await createClient(connection);
        const catalog = await readFleetPresets(client);
        // Names only: whether a secret is already stored, never what it is. A store that cannot be listed
        // simply shows every secret as one to paste.
        const names = await listSecrets(client).then(
          list => list.secrets.map(secret => secret.name),
          () => [] as string[],
        );
        if (!live) return;
        setStored(new Set(names));
        setLoaded({ kind: 'ready', presets: catalog.presets });
      } catch (error) {
        if (live) setLoaded({ kind: 'failed', sentence: changeRefusalSentence(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  if (loaded.kind === 'loading')
    return (
      <p role="status" className="m-0 text-cell text-muted" data-env-login="loading">
        Reading the providers on {machineName}…
      </p>
    );
  if (loaded.kind === 'failed')
    return (
      <p role="alert" className="m-0 text-cell leading-base text-warn" data-env-login="failed">
        {loaded.sentence}
      </p>
    );

  const presets = presetsFor(loaded.presets, harness);
  if (presets.length === 0)
    return (
      <p role="status" className="m-0 text-cell text-muted" data-env-login="none">
        {machineName} offers no provider for this tool.
      </p>
    );
  const backToGrid = (): void => {
    changes.clear();
    setScreen({ kind: 'grid' });
  };

  if (screen.kind === 'paste')
    return (
      <PasteVariables
        presets={presets}
        onBack={backToGrid}
        onContinue={(presetId, prefill) => setScreen({ kind: 'form', presetId, prefill })}
      />
    );

  const preset = screen.kind === 'grid' ? undefined : presets.find(candidate => candidate.id === screen.presetId);
  if (screen.kind === 'added' && preset !== undefined) {
    const added = screen.credentialId;
    const row = data?.credentials.credentials.find(candidate => candidate.id === added);
    return (
      <div className="flex flex-col gap-3" data-env-login="added">
        <p role="status" className="m-0 inline-flex items-center gap-2 text-row font-semibold text-ok">
          <Check size={16} aria-hidden="true" />
          Added {added} from {preset.label}
        </p>
        <p className="m-0 text-cell leading-base text-muted">
          Test it now: the daemon tests the login it saved, sending the key only where the login sends it.
        </p>
        <LoginTest
          credentialId={added}
          act={row?.environment?.test ?? preset.test}
          connection={connection}
          createClient={createClient}
        />
        <div>
          <Button type="button" variant="primary" data-step-next="" onClick={() => onAdded(added)}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  if (screen.kind === 'form' && preset !== undefined)
    return (
      <OneClickLogin
        key={preset.id}
        preset={preset}
        stored={stored}
        onStored={name => setStored(previous => new Set([...previous, name]))}
        {...(screen.prefill === undefined ? {} : { prefill: screen.prefill })}
        list={data?.credentials ?? null}
        machineName={machineName}
        connection={connection}
        createClient={createClient}
        changes={changes}
        reload={reload}
        onBack={backToGrid}
        onSaved={credentialId => {
          setScreen({ kind: 'added', presetId: preset.id, credentialId });
          onSaved?.(credentialId);
        }}
      />
    );

  return (
    <div className="flex min-w-0 flex-col gap-3" data-env-login="grid">
      <p className="m-0 text-ui leading-base text-fg">
        Pick your provider. You are asked only for its key; everything else is filled in.
      </p>
      <ProviderGrid
        presets={presets}
        onPick={presetId => {
          changes.clear();
          setScreen({ kind: 'form', presetId });
        }}
        onPaste={() => setScreen({ kind: 'paste' })}
      />
    </div>
  );
}
