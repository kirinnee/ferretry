/**
 * `fy mcp …` — the Ferretry tools as an MCP server, and the servers a ferret sees: wired once, for the
 * full program and for the MCP slice `bin/fy.ts` routes `mcp` to.
 *
 * A slice because every agent runtime starts `fy mcp serve` and keeps it for the life of its pane, so a
 * machine running thirty ferrets runs thirty of these. Each used to hold the whole CLI in memory to
 * forward tool calls; the slice loads this module and `bin/wiring.ts` and nothing else — see
 * docs/standards/architecture/index.md.
 */
import { TOOLS_SERVER_INSTRUCTIONS } from '@ferretry/fleet/pane-contract';
import type { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { serveMcpOverStdio } from '../src/adapters/mcp/stdio';
import { AgentToolsClient } from '../src/lib/agent-tools/client';
import { paneCredentialValue } from '../src/lib/daemon/credential';
import { McpServer } from '../src/lib/mcp/server';
import { ProtocolMcpServersGateway, McpServersController } from '../src/lib/mcp/servers';
import { registerMcpCommands } from '../src/lib/mcp/commands';
import { assertSemver } from '../src/lib/version';
import {
  agentToolsGateways,
  BINARY_NAME,
  type ConnectionWorld,
  type DaemonWiring,
  executeSlice,
  PRODUCT_NAME,
} from './wiring';

/**
 * The agent tools' client: the agent routes take either form of the pane credential on their own header,
 * the pre-prefix value included. Shared by the MCP server and the `terminal`/`browser page`/`lesson`
 * commands, which act through the same routes as this ferret.
 */
export function agentToolsClient(
  world: ConnectionWorld,
  { client, ownSessionId, restartPatience }: DaemonWiring,
): AgentToolsClient {
  const capability = paneCredentialValue(world.environment);
  return new AgentToolsClient(agentToolsGateways(world, client, restartPatience), {
    ...(capability === undefined ? {} : { capability }),
    ...(ownSessionId === undefined ? {} : { ownSessionId }),
  });
}

/**
 * The MCP group. `serve` acts only as the agent session whose credential is in its environment, and
 * stdout carries nothing but protocol. `ls` / `check` use the operator's client, read as this ferret
 * when run inside one.
 */
export function registerMcpGroup(
  program: Command,
  world: ConnectionWorld,
  wiring: DaemonWiring,
  toolsClient: AgentToolsClient = agentToolsClient(world, wiring),
): void {
  registerMcpCommands(
    program,
    async () => {
      await serveMcpOverStdio(
        new McpServer(
          toolsClient,
          {
            name: PRODUCT_NAME,
            version: assertSemver(pkg.version),
            // One line only. Every behavioural instruction — the tools, the settings rules, and each ferret's own
            // hypermedia, Pack mode and lessons sections — is in the appended system prompt the runtime wrapper
            // composes (fleet's fixed-layer.ts), which a harness weighs above a server's instructions.
            instructions: TOOLS_SERVER_INSTRUCTIONS,
            binary: BINARY_NAME,
          },
          world.environment,
        ),
        Bun.stdin.stream(),
        line => {
          process.stdout.write(line);
        },
      );
    },
    new McpServersController(new ProtocolMcpServersGateway(wiring.client), world.io, wiring.ownSessionId),
  );
}

/** The MCP slice: the program skeleton with this group alone on it. */
export async function execute(argv: string[]): Promise<void> {
  await executeSlice(argv, (program, world, wiring) => {
    registerMcpGroup(program, world, wiring);
  });
}
