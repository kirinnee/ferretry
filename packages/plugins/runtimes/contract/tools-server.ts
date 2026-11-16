/**
 * What the tools server (`fy mcp serve`) says when an agent connects (MCP `initialize` instructions): one line. Every
 * behavioural instruction is in the appended system prompt instead, which a harness weighs far above a server's
 * instructions. Runtimes owns the line (its fixed layer registers the server); the MCP plugin's `serve` reads it from
 * here, because a CLI half may not import a daemon half.
 */
export const TOOLS_SERVER_INSTRUCTIONS =
  "Ferretry's tools: terminals, browser pages, configuration and lessons. How to use them is in your system prompt.";

/**
 * The variable the Claude launch puts in the tools server's own `--mcp-config` environment, ONLY when the same argv
 * carries `--dangerously-load-development-channels`. `fy mcp serve` reads it to decide whether to declare and pump the
 * channel: a server that polled for a channel Claude was never given would make the daemon take a dead channel for a
 * listening one. Not `FY_`-prefixed: the shell hands a CLI half only the names its manifest declares (`cliEnvReads`).
 */
export const CHANNEL_LAUNCH_ENV = 'FERRETRY_CHANNEL';
