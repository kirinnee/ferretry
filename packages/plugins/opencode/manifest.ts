import { definePlugin } from '@ferretry/kernel/manifest';
import type { ConfigDef } from '@ferretry/kernel/contract';
import { Harnesses, StartDecide } from '@ferretry/core-ferrets/contract';
import { LoginsPort } from '@ferretry/plugin-logins/contract';
import { OPENCODE, OPENCODE_CONFIG, OPENCODE_HOMES, OPENCODE_SESSIONS } from './contract/index.ts';

export default definePlugin({
  id: OPENCODE,
  title: 'OpenCode',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['harness'],
  uses: { logins: LoginsPort },
  data: { config: [OPENCODE_CONFIG as ConfigDef], state: [OPENCODE_HOMES, OPENCODE_SESSIONS] },
  hooks: { takes: [{ hook: Harnesses, key: OPENCODE }, { hook: StartDecide }] },
  permissions: { roots: ['agent-homes'], spawn: ['opencode', 'env', 'which', 'printenv'], secrets: [], network: [] },
});
