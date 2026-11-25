import { definePlugin } from '@ferretry/kernel/manifest';
import { CONNECTOR_CALLS, CONNECTOR_CONFIG, CONNECTOR_STATE, CONNECTOR_WORDS } from './contract/index.ts';

/**
 * Connector (docs/mcp-connector.md): the remote MCP connector — the Claude app reaches this machine's ferrets after the
 * owner approves it. THIS slice is the contract and the pure OAuth authority (`daemon/lib/oauth/`) only: it declares
 * the config, the state and the words and serves nothing. The door, the routes, the CLI and the tools arrive in later
 * units, each adding its own lines here.
 */
export default definePlugin({
  id: 'connector',
  title: 'Connector',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  words: CONNECTOR_WORDS,

  data: {
    state: [CONNECTOR_STATE, CONNECTOR_CALLS],
    config: [CONNECTOR_CONFIG],
  },
});
