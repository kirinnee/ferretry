/**
 * What the tools server (`fy mcp serve`) says when an agent connects (MCP `initialize` instructions): one line. Every
 * behavioural instruction is in the appended system prompt instead, which a harness weighs far above a server's
 * instructions. Runtimes owns the line (its fixed layer registers the server); the MCP plugin's `serve` reads it from
 * here, because a CLI half may not import a daemon half.
 */
export const TOOLS_SERVER_INSTRUCTIONS =
  "Ferretry's tools: terminals, browser pages, configuration and lessons. How to use them is in your system prompt.";
