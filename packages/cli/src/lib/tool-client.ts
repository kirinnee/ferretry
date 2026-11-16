/**
 * The agent-tool client: what `fy mcp serve` and a ferret's tools call through. It is the same guard as a verb's
 * (§9.6): the owning plugin must be present, on and carry this build's contract hash, and a person-only tool is
 * refused in a pane before the daemon is contacted.
 *
 * A tool is dispatched at the kernel's tool door, `POST /v1/agent/tools` with `{ tool, input }`. The door names no
 * ferret and no plugin: the credential this process presents decides who is calling, and the tool name decides which
 * plugin runs it (a tool name is unique across plugins).
 */
import { PERSON_ONLY_REFUSAL } from './credential.ts';
import { AGENT_TOOLS_ROUTE, type ClientDeps, ensureAllowed, sendChecked, toolKey } from './client.ts';
import { EXIT, ShellError } from './errors.ts';
import { buildRequest } from './request.ts';

export class ToolClient {
  constructor(private readonly deps: ClientDeps) {}

  async call(plugin: string, tool: string, input: unknown): Promise<unknown> {
    const facts = this.deps.surfaces.tools.get(toolKey(plugin, tool));
    if (facts === undefined) throw new ShellError(`${plugin} declares no tool "${tool}"`, EXIT.failure);
    if (this.deps.inPane && facts.caller === 'person') throw new ShellError(PERSON_ONLY_REFUSAL, EXIT.failure);
    await ensureAllowed(this.deps, plugin);
    return await sendChecked(this.deps, buildRequest(AGENT_TOOLS_ROUTE, { body: { tool, input: input ?? {} } }), [
      plugin,
    ]);
  }
}
