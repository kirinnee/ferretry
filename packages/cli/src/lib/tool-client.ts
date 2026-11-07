/**
 * The agent-tool client: what `fy mcp serve` and a ferret's tools call through. It is the same guard as a verb's
 * (§9.6): the owning plugin must be present, on and carry this build's contract hash, and a person-only tool is
 * refused in a pane before the daemon is contacted.
 *
 * ASSUMPTION, one place: a tool is dispatched at `POST /v1/tools/<plugin>/<tool>` with the input as the JSON body.
 * The kernel host owns the tool path; change {@link toolPath} when it lands.
 */
import { PERSON_ONLY_REFUSAL } from './credential.ts';
import { type ClientDeps, ensureAllowed, sendChecked, toolKey } from './client.ts';
import { EXIT, ShellError } from './errors.ts';

export const toolPath = (plugin: string, tool: string): string =>
  `/v1/tools/${encodeURIComponent(plugin)}/${encodeURIComponent(tool)}`;

export class ToolClient {
  constructor(private readonly deps: ClientDeps) {}

  async call(plugin: string, tool: string, input: unknown): Promise<unknown> {
    const facts = this.deps.surfaces.tools.get(toolKey(plugin, tool));
    if (facts === undefined) throw new ShellError(`${plugin} declares no tool "${tool}"`, EXIT.failure);
    if (this.deps.inPane && facts.caller === 'person') throw new ShellError(PERSON_ONLY_REFUSAL, EXIT.failure);
    await ensureAllowed(this.deps, plugin);
    return await sendChecked(this.deps, { method: 'POST', path: toolPath(plugin, tool), body: input ?? {} });
  }
}
