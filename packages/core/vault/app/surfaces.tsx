import type { RendererProps } from '@ferretry/kernel/manifest';
import { InputCardHost } from './features/input/input-card-host.tsx';
import { SecretsSurface } from './features/secrets/secrets-surface.tsx';
import type { VaultClient } from './shell.tsx';

/** Settings › ‹machine› › Secrets: create, replace and delete; only names and instants are shown. */
export function secretsTab(client: VaultClient) {
  return function SecretsTab() {
    return <SecretsSurface client={client} />;
  };
}

/** `ask:input`: the owner's form for a value a ferret asked for, read from the daemon by the ask's ferret. */
export function inputRenderer(client: VaultClient) {
  return function Input({ value }: RendererProps) {
    return <InputCardHost client={client} value={value} />;
  };
}
