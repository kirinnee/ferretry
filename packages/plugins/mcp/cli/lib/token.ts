/**
 * `fy mcp token <variable>`: the current `Authorization` header behind one of this ferret's MCP sign-in variables, as
 * the JSON object Claude Code's `headersHelper` expects on stdout (docs/mcp-oauth.md › A ferret that outlives its token).
 *
 * Claude runs it at connect time and again after a 401, so a ferret that outlives its access token keeps working instead
 * of sending the one it was launched with. It acts only as THIS ferret (`FY_SESSION_ID`), with the credential the fy shell
 * presents for it; the daemon refuses anybody else. On success it prints the headers object and NOTHING else, because a
 * helper's whole stdout is parsed. On failure the daemon's own sentence goes to stderr and the exit code is 1.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { McpTokenAnswerSchema, McpTokenRequestSchema } from '../../contract/index.ts';

const ROUTE = 'POST /v1/ferrets/:ferretId/mcp/token';

/** Plain on purpose: stdout is the JSON as given (no colour, no newline noise), stderr is words. */
export interface McpTokenOutput {
  out(text: string): void;
  err(text: string): void;
}

export class McpTokenController {
  constructor(
    private readonly client: Pick<PluginClient, 'call'>,
    private readonly io: McpTokenOutput,
    /** The ferret this command runs in, when it runs in one (`FY_SESSION_ID`). */
    private readonly ownFerretId: string | undefined,
  ) {}

  /** The exit code. */
  async token(variable: string | undefined): Promise<number> {
    if (this.ownFerretId === undefined) {
      this.io.err('fy mcp token only works inside a ferret: it gives that ferret its own MCP sign-in token.\n');
      return 2;
    }
    const request = McpTokenRequestSchema.safeParse({ variable });
    if (!request.success) {
      this.io.err(
        `“${variable ?? ''}” is not an MCP sign-in variable (they look like FY_MCP_<NAME>_<DIGEST>_TOKEN).\n`,
      );
      return 2;
    }
    try {
      const answer = McpTokenAnswerSchema.parse(
        await this.client.call(ROUTE, { params: { ferretId: this.ownFerretId }, body: request.data }),
      );
      this.io.out(JSON.stringify(answer.headers));
      return 0;
    } catch (error) {
      this.io.err(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
}
