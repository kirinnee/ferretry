import type { FencedPath, FerretId, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { LaunchRefusal, materializeSkills, type LaunchSpec } from '@ferretry/core-ferrets/contract';
import type { JsonValue } from '@ferretry/std';
import { isolatedEnvironment } from './environment.ts';

export const OPENCODE_FACTS = {
  displayName: 'OpenCode',
  instructionFile: 'AGENTS.md',
  skillsDir: 'skills',
  mcp: { format: 'json' as const, file: 'opencode.json' },
  transcriptFormat: 'opencode-export',
  catalogHalf: 'opencode',
};
const record = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Launch parts use the shared MCP shape; V2 reads mcp.servers and command arrays. */
function mcpServer(value: JsonValue): JsonValue {
  if (!record(value)) throw new LaunchRefusal('OpenCode received an unsupported MCP server');
  if (typeof value.url === 'string')
    return {
      type: 'remote',
      url: value.url,
      ...(record(value.headers ?? null) ? { headers: value.headers } : {}),
    } as JsonValue;
  const command =
    typeof value.command === 'string'
      ? [value.command, ...(Array.isArray(value.args) ? value.args : [])]
      : value.command;
  if (!Array.isArray(command) || !command.every(arg => typeof arg === 'string'))
    throw new LaunchRefusal('OpenCode received an unsupported MCP command');
  return { type: 'local', command, ...(record(value.env ?? null) ? { environment: value.env } : {}) } as JsonValue;
}

export function opencodeHomes(kernel: Pick<KernelPorts, 'roots'>) {
  const root = (ferret: FerretId): RootHandle => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(ferret)) throw new LaunchRefusal('OpenCode needs a plain ferret ID');
    return kernel.roots.root('agent-homes', { ferret, subfolder: ferret });
  };
  const resolve = (home: RootHandle, relative: string): FencedPath => {
    const at = home.resolve(relative);
    if (!at.ok) throw new LaunchRefusal('The private OpenCode home could not be placed');
    return at.value;
  };
  const homeFor = async (ferret: FerretId) => resolve(root(ferret), '');
  return {
    root,
    homeFor,
    async prepareHome(spec: LaunchSpec) {
      if (spec.home !== (await homeFor(spec.ferret)))
        throw new LaunchRefusal('The launch home is not this ferret’s OpenCode home');
      if (spec.credential !== undefined)
        throw new LaunchRefusal(
          'OpenCode accepts API keys and endpoints only; subscription sign-ins are not supported',
        );
      if (spec.model === undefined || !/^[^/\s]+\/[^\s]+$/u.test(spec.model))
        throw new LaunchRefusal('Choose an OpenCode model as provider/model');
      const home = root(spec.ferret);
      const all = kernel.roots.root('agent-homes');
      await all.ensurePrivateDirectory(resolve(all, spec.ferret));
      for (const directory of Object.values(isolatedEnvironment(spec.home)).filter(
        path => !path.endsWith('.db') && !path.endsWith('.json'),
      )) {
        await home.makeDirectory(resolve(home, directory.slice(spec.home.length + 1)), { mode: 0o700 });
      }
      await home.makeDirectory(resolve(home, 'config/opencode'), { mode: 0o700 });
      await materializeSkills(home, spec.parts, []);
      const instruction = resolve(home, OPENCODE_FACTS.instructionFile);
      const text = [
        ...spec.instructions.map(item => item.text),
        ...spec.parts.flatMap(part => (part.kind === 'instruction' ? [part.text] : [])),
      ].join('\n\n');
      await home.writeText(instruction, `${text}\n`);
      const servers = Object.fromEntries(
        spec.parts.flatMap(part => (part.kind === 'mcp' ? [[part.name, mcpServer(part.config)]] : [])),
      );
      const config = resolve(home, OPENCODE_FACTS.mcp.file);
      const model = spec.effort === undefined ? spec.model : `${spec.model.split('#')[0]}#${spec.effort}`;
      await home.writeText(
        config,
        `${JSON.stringify({ model, instructions: [instruction], skills: [`${spec.home}/skills`], mcp: { servers } }, null, 2)}\n`,
      );
      return { files: [instruction, config], args: [] };
    },
  };
}
