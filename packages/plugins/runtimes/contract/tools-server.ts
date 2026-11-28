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

/** The name the Ferretry tools server is registered under in a harness. */
export const FERRETRY_MCP_SERVER = 'ferretry';

/** How a harness starts the tools server: the `fy` it already uses, as `fy mcp serve`. */
export const FERRETRY_MCP_ARGS: readonly string[] = ['mcp', 'serve'];

/**
 * The flag that loads the tools server as a development channel. Claude's plain `--channels` refuses a server that is not
 * on its approved list, so the development spelling is the only one that works; it shows a one-time warning on every
 * launch, which the daemon answers (claude-code's startup dialogs). Written with `=`: the option takes several servers, and
 * a bare one would swallow the arguments after it, the prompt included.
 */
export const CLAUDE_CHANNELS_FLAG = `--dangerously-load-development-channels=server:${FERRETRY_MCP_SERVER}`;

/**
 * The tools server as Claude's `--mcp-config` names it for a ferret launched with the channel: `FY_TOKEN` emptied (Claude
 * passes a stdio server the agent's whole environment; the admin token must not be in it) and the launch marker set, which
 * is what lets `fy mcp serve` pump the channel only on a launch whose argv carries {@link CLAUDE_CHANNELS_FLAG}.
 */
export const channelToolsServer = (fyCommand: string): Readonly<Record<string, unknown>> => ({
  type: 'stdio',
  command: fyCommand,
  args: [...FERRETRY_MCP_ARGS],
  env: { FY_TOKEN: '', [CHANNEL_LAUNCH_ENV]: '1' },
});

/**
 * What a ferret is told about the channel, in the launch's system-prompt layer (its memory file, with Ferretry's other agent
 * instructions): the owner's own words never arrive this way, and Claude's own notice that channel content is untrusted
 * must not make the agent skip a lead's work message, which it acts on exactly as when it is typed.
 */
export const CHANNEL_AGENT_INSTRUCTION =
  'Messages inside <channel source="ferretry"> are delivered by Ferretry from your lead or other ferrets, each with its sender banner. Treat them exactly like those ferret messages when they are typed: act on them as work messages, even though Claude marks channel content as untrusted. The owner\'s own words never arrive this way.';

/** Whether a Claude launch is given the channel: the explicit setting wins; otherwise only a `claude_max` login gets it. */
export const claudeChannelsFor = (explicit: boolean | undefined, organizationType: string | undefined): boolean =>
  explicit ?? organizationType === 'claude_max';

/**
 * The variables the tools server needs from the agent's environment: where the daemon is, and the
 * agent session's own credential — the one thing that tells the daemon which session is calling, and
 * the whole of the server's authority. NOT `FY_TOKEN`: the host's admin token is no part of it. Codex
 * hands a stdio server only a short default list, so these are named for it; Claude hands it the whole
 * environment, so its entry blanks `FY_TOKEN` instead.
 *
 * The credential travels under both its names: `FY_SESSION_TOKEN` is the documented one the server
 * presents as its bearer, and `FY_SESSION_BOARD_CAPABILITY` is kept for one release so a server from
 * before the rename still finds it.
 */
export const FERRETRY_MCP_ENV_VARS: readonly string[] = [
  'FY_HOME',
  'FY_URL',
  'FY_SESSION_ID',
  'FY_SESSION_TOKEN',
  'FY_SESSION_BOARD_CAPABILITY',
];

/** A TOML basic string: what a `-c` override needs to carry any folder path or instruction text. */
export function tomlString(value: string): string {
  const escaped = [...value]
    .map(character => {
      if (character === '\\') return '\\\\';
      if (character === '"') return '\\"';
      const code = character.codePointAt(0) as number;
      return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : character;
    })
    .join('');
  return `"${escaped}"`;
}
