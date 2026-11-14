import { describe, it } from 'bun:test';
import type { CliContext, Manifest, VerbHandler } from '@ferretry/kernel/manifest';
import should from 'should';
import { z } from 'zod';
import { registry } from '../../../src/generated/commands.ts';

/**
 * `fy mcp serve` lists a hand-written row per agent tool (5.0's zod inputs carry no descriptions, so the words cannot be
 * generated). This is the seam between the two: every manifest agent tool is a row, no row is without one, and a row's
 * input names are the zod input's, so a tool whose input changed fails here instead of in a model's hands.
 *
 * The rows are read the way a harness reads them: the mcp plugin's real cli half is built and asked `tools/list` over the
 * standard input it is handed.
 */
const everyManifest = [registry.kernel, ...registry.plugins];
const declared = everyManifest.flatMap(entry => entry.manifest.actions?.agentTools ?? []);

/**
 * Tools whose owner cannot serve them yet: the four secure-copy tools (a capture has no masking, command or page seam on
 * 5.0). Their owner does not declare them in its manifest (they are declared once served), and the CLI lists none of them: an
 * agent is not told to call a tool that answers `is not built yet`.
 */
const UNBUILT = ['secure_copy', 'secure_list', 'secure_discard', 'secure_paste'];

/**
 * Tools whose manifest declaration carries no zod `input` (their owner parses the call itself), so their row's property
 * names cannot be compared here. GAP: a manifest `input` on each would make this test cover them; until then the list is
 * pinned, so a tool that gains an `input` is held to its row, and a new tool without one is noticed.
 */
const NO_MANIFEST_INPUT = [
  'input_wait',
  'account_hint',
  'lessons_suggest',
  'terminal_request_input',
  ...declared.filter(tool => tool.name.startsWith('browser_')).map(tool => tool.name),
];

interface Row {
  readonly name: string;
  readonly inputSchema: { readonly properties?: Record<string, unknown> };
}

async function listedRows(): Promise<readonly Row[]> {
  const mcp = registry.plugins.find(plugin => plugin.id === 'mcp');
  if (mcp === undefined) throw new Error('the registry has no mcp plugin');
  const half = await mcp.load();
  const out: string[] = [];
  const request = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`;
  const context = {
    manifest: mcp.manifest,
    client: { call: async () => undefined, subscribe: () => () => undefined },
    io: { out: (text: string) => out.push(text), err: () => undefined, isTty: false },
    stdin: () =>
      (async function* () {
        yield new TextEncoder().encode(request);
      })(),
    env: {},
  } as unknown as CliContext<Manifest>;
  const verbs = (half.build as (c: CliContext<Manifest>) => { verbs: Record<string, VerbHandler> })(context).verbs;
  await verbs['mcp serve']?.({ args: [], options: {} });
  return (JSON.parse(out.join('')) as { result: { tools: Row[] } }).result.tools;
}

const namesOf = (schema: z.ZodType): string[] =>
  Object.keys(
    (z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as { properties?: object }).properties ?? {},
  ).sort();

describe('the MCP tool rows against the manifests’ agent tools', async () => {
  const rows = await listedRows();

  it('should list exactly the tools the manifests declare, less the ones whose owner has not built them', () => {
    should(rows.map(row => row.name).sort()).eql(
      declared
        .map(tool => tool.name)
        .filter(name => !UNBUILT.includes(name))
        .sort(),
    );
  });

  it('should neither declare nor list a tool its owner has not built (the M2 shape: out of the manifests, out of the list)', () => {
    const names = declared.map(tool => tool.name);
    const listed = rows.map(row => row.name);
    for (const name of UNBUILT) {
      should(names).not.containEql(name);
      should(listed).not.containEql(name);
    }
  });

  it('should pin the tools that declare no zod input, so the gap is the whole of it', () => {
    const without = declared.filter(tool => tool.input === undefined).map(tool => tool.name);
    should(without.filter(name => !UNBUILT.includes(name)).sort()).eql([...NO_MANIFEST_INPUT].sort());
  });

  for (const tool of declared.filter(candidate => candidate.input !== undefined && !UNBUILT.includes(candidate.name)))
    it(`should give ${tool.name} the input names its zod input has`, () => {
      const row = rows.find(candidate => candidate.name === tool.name);
      should(Object.keys(row?.inputSchema.properties ?? {}).sort()).eql(namesOf(tool.input as z.ZodType));
    });
});
