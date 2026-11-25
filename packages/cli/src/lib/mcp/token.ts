/**
 * `fy mcp token <variable>`: the current `Authorization` header behind one of this ferret's MCP sign-in variables,
 * as the JSON object Claude Code's `headersHelper` expects on stdout (docs/mcp-oauth.md › A ferret that outlives its
 * token).
 *
 * Fleet writes it into every signed-in MCP server's entry, so Claude runs it at connect time and again after a 401:
 * a ferret that outlives its twelve-hour access token keeps working instead of sending the one it was launched
 * with. It acts only as THIS ferret (`FY_SESSION_ID`) — the daemon refuses anyone else — and on success prints the
 * headers object and NOTHING else, because a helper's whole stdout is parsed. On failure the daemon's own sentence
 * goes to stderr and the exit code is 1.
 */
import type { IFyApiClient, McpTokenAnswer } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { McpTokenAnswerSchema, McpTokenRequestSchema } from '@ferretry/protocol/mcp-inventory';

/** The only client capability the gateway consumes. */
export type McpTokenApiClient = Pick<IFyApiClient, 'request'>;

export interface IMcpTokenGateway {
  token(sessionId: string, variable: string): Promise<McpTokenAnswer>;
}

export class ProtocolMcpTokenGateway implements IMcpTokenGateway {
  constructor(private readonly client: McpTokenApiClient) {}

  async token(sessionId: string, variable: string): Promise<McpTokenAnswer> {
    return await this.client.request(`/v1/sessions/${encodeURIComponent(sessionId)}/mcp/token`, McpTokenAnswerSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(McpTokenRequestSchema.parse({ variable })),
    });
  }
}

/**
 * Plain on purpose: `report` is stdout exactly as given (`success` paints it green, which would corrupt the JSON a
 * helper's whole stdout is parsed as), and `diagnostic` is stderr without colour.
 */
export interface IMcpTokenOutput {
  report(message: string): void;
  diagnostic(message: string): void;
  setExitCode(code: number): void;
}

export class McpTokenController {
  constructor(
    private readonly gateway: IMcpTokenGateway,
    private readonly out: IMcpTokenOutput,
    /** The ferret this command runs in, when it runs in one. */
    private readonly ownSessionId: string | undefined,
  ) {}

  async token(variable: string): Promise<void> {
    if (this.ownSessionId === undefined) {
      this.out.diagnostic('fy mcp token only works inside a ferret: it gives that ferret its own MCP sign-in token.');
      this.out.setExitCode(2);
      return;
    }
    if (!McpTokenRequestSchema.safeParse({ variable }).success) {
      this.out.diagnostic(
        `“${variable}” is not an MCP sign-in variable (they look like FY_MCP_<NAME>_<DIGEST>_TOKEN).`,
      );
      this.out.setExitCode(2);
      return;
    }
    try {
      const answer = await this.gateway.token(this.ownSessionId, variable);
      this.out.report(JSON.stringify(answer.headers));
    } catch (error) {
      this.out.diagnostic(
        error instanceof FyHttpError ? error.message : `could not reach the daemon: ${errorWords(error)}`,
      );
      this.out.setExitCode(1);
    }
  }
}

const errorWords = (error: unknown): string => (error instanceof Error ? error.message : String(error));
