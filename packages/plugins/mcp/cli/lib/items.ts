import {
  type ConfigItemKind,
  type ItemDocument,
  ItemCommandError,
  itemEnvPairs,
  itemFlag,
  itemFlagList,
} from '@ferretry/kernel/manifest';

/** The tool a person names: `claude` is Claude Code, whose key is the plugin's id. */
function harnessKeyOf(word: string): 'claude-code' | 'codex' {
  if (word === 'claude' || word === 'claude-code') return 'claude-code';
  if (word === 'codex') return 'codex';
  throw new ItemCommandError(`--harness takes claude or codex, got "${word}".`);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * `config/mcp/<name>.yaml` from the flags: `--command` with its `--arg`s, or `--url`, and `--env NAME=value` (a value that
 * is a credential is written `${secret:NAME}`; the daemon refuses a raw one). An edit keeps every variable it does not
 * name, and moves between a command and an address by dropping what belonged to the other.
 */
export const mcpItemKind: ConfigItemKind = {
  collection: 'mcp',
  noun: 'MCP server',
  layer: 'mcp',
  command: 'mcp',
  fields(invocation, current) {
    const command = itemFlag(invocation, 'command');
    const url = itemFlag(invocation, 'url');
    const harness = itemFlag(invocation, 'harness');
    const args = itemFlagList(invocation, 'arg');
    const pairs = itemEnvPairs(itemFlagList(invocation, 'env'));
    const document: Record<string, unknown> = { ...(current ?? {}) };
    if (url !== undefined && command === undefined) {
      // An address replaces a command: `args` and `env` start a command, and the daemon refuses a server that has both.
      delete document.command;
      delete document.args;
      delete document.env;
      document.url = url;
    } else if (command !== undefined && url === undefined) {
      delete document.url;
      delete document.auth;
      delete document.oauth;
      document.command = command;
    } else if (command !== undefined) {
      document.command = command;
      document.url = url;
    }
    if (args.length > 0) document.args = args;
    if (Object.keys(pairs).length > 0)
      document.env = { ...(document.env as Record<string, string> | undefined), ...pairs };
    if (harness !== undefined) document.harness = harnessKeyOf(harness);
    if (current === undefined && document.command === undefined && document.url === undefined)
      throw new ItemCommandError('An MCP server needs a --command to start or a --url to reach.');
    return document;
  },
  details(document: ItemDocument) {
    const env =
      document.env !== null && typeof document.env === 'object'
        ? Object.entries(document.env as Record<string, unknown>)
        : [];
    return [
      ...(typeof document.command === 'string'
        ? [`Runs: ${[document.command, ...strings(document.args)].join(' ')}`]
        : []),
      ...(typeof document.url === 'string' ? [`Address: ${document.url}`] : []),
      ...(typeof document.harness === 'string' ? [`For: ${document.harness}`] : []),
      ...env.map(([name, value]) => `Env: ${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`),
    ];
  },
};
