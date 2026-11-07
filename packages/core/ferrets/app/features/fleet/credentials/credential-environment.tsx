/**
 * An environment login's page section (docs/provider-presets.md): its preset, its variables — a plain
 * value as it is, a secret by NAME with "set ✓" or "needs" — its cloud credential reference, its Codex
 * provider, what it still needs, and its Test. No value of a secret is ever on this wire.
 */

import type { FleetCredentialEnvironment, FleetEnvironmentVariable } from '@ferretry/protocol';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { LoginTest } from './login-test.tsx';
import { SecretPill } from './secret-pill.tsx';

/** "Environment · GLM / Z.ai", or "Environment" for a login no preset made. */
export const environmentChip = (environment: FleetCredentialEnvironment): string =>
  environment.preset === undefined ? 'Environment' : `Environment · ${environment.preset.label}`;

function VariableValue({ variable }: { readonly variable: FleetEnvironmentVariable }) {
  if (variable.kind === 'plain')
    return (
      <span className="min-w-0 break-all font-mono text-muted">{variable.value === '' ? '""' : variable.value}</span>
    );
  if (variable.kind === 'hidden') return <span className="text-muted">hidden</span>;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {variable.secrets.map(name => (
        <SecretPill key={name} name={name} set={variable.set} />
      ))}
    </span>
  );
}

export interface CredentialEnvironmentProps {
  readonly credentialId: string;
  readonly environment: FleetCredentialEnvironment;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly online: boolean;
}

export function CredentialEnvironment({
  credentialId,
  environment,
  connection,
  createClient,
  online,
}: CredentialEnvironmentProps) {
  return (
    <div className="kt-panel flex min-w-0 flex-col gap-3 p-panel" data-credential-environment={credentialId}>
      <p className="m-0 text-cell leading-base text-muted">
        Variables injected into the CLI at launch. Secrets come from the secret store and are never shown.
        {environment.preset === undefined ? null : (
          <>
            {' '}
            Made from {environment.preset.label} · docs:{' '}
            <span className="break-all font-mono">{environment.preset.docs}</span>
          </>
        )}
      </p>
      {environment.missingPreset === undefined ? null : (
        <p className="m-0 text-cell text-warn" data-credential-missing-preset="">
          Preset {environment.missingPreset} is not on this machine any more.
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {environment.variables.map(variable => (
          <li
            key={variable.name}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-cell"
            data-credential-variable={variable.name}
          >
            <span className="break-all font-mono font-semibold text-fg">{variable.name}</span>
            <VariableValue variable={variable} />
          </li>
        ))}
      </ul>
      {environment.cloudCredential === undefined ? null : (
        <p className="m-0 text-cell leading-base text-fg" data-credential-cloud="">
          <span className="font-mono">{environment.cloudCredential.reference}</span> —{' '}
          {environment.cloudCredential.sentence}
        </p>
      )}
      {environment.codexProvider === undefined ? null : (
        <p className="m-0 text-cell leading-base text-fg" data-credential-codex-provider="">
          Codex model provider: {environment.codexProvider.name}
          {environment.codexProvider.baseUrl === undefined ? null : (
            <span className="break-all font-mono text-muted"> · {environment.codexProvider.baseUrl}</span>
          )}
        </p>
      )}
      {environment.missingSecrets.length === 0 ? null : (
        <p className="m-0 text-cell font-semibold text-warn" data-credential-needs="">
          needs: {environment.missingSecrets.join(', ')} — add {environment.missingSecrets.length === 1 ? 'it' : 'them'}{' '}
          in Settings › Secrets before a runtime on it launches.
        </p>
      )}
      <LoginTest
        credentialId={credentialId}
        act={environment.test}
        connection={connection}
        createClient={createClient}
        disabled={!online}
      />
    </div>
  );
}
