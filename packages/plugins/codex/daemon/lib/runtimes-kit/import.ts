import { isAbsolute, join } from 'node:path';
import type {
  KitHarvestInput,
  KitHarvestParts,
  KitHostLogin,
  KitHostScanInput,
  KitHostSetup,
  RuntimesHarnessKit,
} from '@ferretry/plugin-runtimes/contract';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const importSetup = { settingsFormat: 'toml', settingsFile: 'config.toml', instructionsName: 'AGENTS.md' } as const;

/** Keys a runtime's plumbing sets itself (§8.3), dropped from an imported settings file. */
const PLUMBING_KEYS = ['cli_auth_credentials_store', 'sqlite_home'] as const;

/** Where Codex keeps its MCP servers: the `mcp_servers` table of `config.toml`; a server marked `enabled = false` is left out. */
const mcpImport = {
  document: 'settings',
  format: 'toml',
  file: 'config.toml',
  table: 'mcp_servers',
  knownKeys: ['command', 'args', 'env', 'url', 'enabled'],
  skipDisabled: true,
} as const;

/** The profiles a `config.toml` declares: names, and the two keys an import would keep. Never anything else. */
function profileHints(settings: Readonly<Record<string, unknown>>): NonNullable<KitHarvestParts['profileHints']> {
  const table = settings.profiles;
  if (!isRecord(table)) return [];
  return Object.entries(table).flatMap(([name, value]) => {
    if (name === '' || !isRecord(value)) return [];
    const model = typeof value.model === 'string' && value.model !== '' ? value.model : undefined;
    const effort =
      typeof value.model_reasoning_effort === 'string' && value.model_reasoning_effort !== ''
        ? value.model_reasoning_effort
        : undefined;
    return [{ name, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }];
  });
}

async function scanHost(input: KitHostScanInput): Promise<KitHostSetup> {
  const named = input.configuredHome?.trim() ?? '';
  if (named !== '' && !isAbsolute(named)) {
    // A relative CODEX_HOME would be read against a directory the daemon cannot know, so nothing is read.
    const reason = 'CODEX_HOME is set to a relative path, so your Codex setup could not be found';
    const source = input.configuredHome ?? '';
    return {
      login: { state: 'not-shareable', reason },
      instructions: { kind: 'unreadable', source, reason },
      settings: { kind: 'unreadable', source, reason },
      hooks: { kind: 'absent', source },
      skills: [],
      problems: [],
    };
  }
  const home = named === '' ? join(input.userHome, '.codex') : join(named);
  const [instructions, settings, hooks, skills] = await Promise.all([
    input.read(home, join(home, 'AGENTS.md')),
    input.read(home, join(home, 'config.toml')),
    input.read(home, join(home, 'hooks.json')),
    input.skills(home, join(home, 'skills')),
  ]);
  const login = await input.login();
  return { login, instructions, settings, hooks, skills: skills.found, problems: skills.problems };
}

function harvest(input: KitHarvestInput): KitHarvestParts {
  const { rest } = input;
  const profiles = profileHints(rest);
  delete rest.mcp_servers;
  for (const key of PLUMBING_KEYS) delete rest[key];
  let envImport: KitHarvestParts['envImport'];
  const policy = rest.shell_environment_policy;
  if (isRecord(policy) && isRecord(policy.set)) {
    envImport = input.skippedEnv
      ? undefined
      : input.importEnvironment(policy.set, 'shell_environment_policy.set.', importSetup.settingsFile);
    const kept = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== 'set'));
    if (Object.keys(kept).length === 0) delete rest.shell_environment_policy;
    else rest.shell_environment_policy = kept;
  }
  const { hooks } = input;
  // Hooks are counted so the screen can say "found N, not imported", and dropped: Ferretry runs none of the host's.
  const counted =
    hooks !== undefined && Object.keys(hooks.document).length > 0
      ? {
          source: hooks.source,
          count: input.countHooks(isRecord(hooks.document.hooks) ? hooks.document.hooks : hooks.document),
        }
      : undefined;
  return { hooks: counted, envImport, mcpSource: input.source, profileHints: profiles };
}

function loginNote(login: KitHostLogin): string {
  const label = 'Codex';
  const own = 'codex';
  const who = login.email === undefined ? 'your login' : login.email;
  switch (login.state) {
    case 'signed-in':
      return `Login · ${who}. Ferretry and your own \`${own}\` share this login: signing out in one signs out both.`;
    case 'refresh-due':
      return `Login · ${who} · Refresh due. Ferretry renews it the first time you launch.`;
    case 'not-signed-in':
      return `${label} isn't signed in on this machine. Your setup was still imported; sign in later and every runtime on this login can launch.`;
    case 'unknown':
      return `${label} sign-in is unknown (${login.reason ?? 'Logins has no host discovery fact'}). Your login stays shared in place.`;
    case 'unreadable':
      return `Ferretry couldn't read your ${label} login (${login.reason ?? 'no reason given'}). It is still shared in place; check it on the Sign-ins tab.`;
    default:
      return `Your ${label} login can't be shared in place (${login.reason ?? 'it is not kept in a file'}), so this login needs its own sign-in.`;
  }
}

/** Codex's host scan, import decisions and login notes; host reads and secret handling remain guarded by Runtimes. */
export const codexImportKit: RuntimesHarnessKit = { scanHost, importSetup, mcpImport, harvest, loginNote };
