import { CLAUDE_REDIRECT_URI, CONNECTOR_DEFAULT_PORT, type ConnectorConfig } from '../../contract/index.ts';

/**
 * What `config/connector.yaml` means for the listener (docs/mcp-connector.md "Configuration"). The kernel has already
 * checked the file, so this is total: every config answers a value, and a switched-off one says so in the sentence a
 * person reads in `fy connector` and the app.
 */
export type ConnectorSettings =
  | {
      readonly kind: 'enabled';
      /**
       * The public origin the operator configured, no trailing slash: the issuer. `undefined` means none was written,
       * and the issuer is this machine's built-in tunnel hostname once that is known. A configured address ALWAYS wins
       * and is never overwritten.
       */
      readonly publicUrl: string | undefined;
      readonly port: number;
      /** Claude's callback first, then the operator's extras, de-duplicated, exact strings. */
      readonly redirectUris: readonly string[];
    }
  | { readonly kind: 'disabled'; readonly reason: string };

export const CONNECTOR_OFF_SENTENCE = 'The connector is off. Switch it on in the app (Settings › Claude connector).';

export function connectorSettings(config: ConnectorConfig): ConnectorSettings {
  if (!config.enabled) return { kind: 'disabled', reason: CONNECTOR_OFF_SENTENCE };
  return {
    kind: 'enabled',
    publicUrl: config.publicUrl === undefined ? undefined : new URL(config.publicUrl).origin,
    port: config.port ?? CONNECTOR_DEFAULT_PORT,
    redirectUris: [...new Set([CLAUDE_REDIRECT_URI, ...config.extraRedirectUris])],
  };
}
