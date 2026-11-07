export interface ClaudeOAuthClient {
  readonly clientId: string;
  readonly callbackPort?: number;
}

export type McpDeclaration =
  | {
      readonly name: string;
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly disabled?: true;
    }
  | {
      readonly name: string;
      readonly transport: 'http' | 'sse';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      /** Codex's `bearer_token_env_var`: a variable the harness reads the token from. */
      readonly bearerVariable?: string;
      /** Claude's `oauth` block: a client registered by hand with the provider (`.mcp.json` only). */
      readonly oauth?: ClaudeOAuthClient;
      readonly disabled?: true;
    };
