import { isAbsolute, join } from 'node:path';
import type {
  KitHarvestInput,
  KitHarvestParts,
  KitHostDocumentRead,
  KitHostLogin,
  KitHostScanInput,
  KitHostSetup,
  RuntimesHarnessKit,
} from '@ferretry/plugin-runtimes/contract';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const importSetup = { settingsFormat: 'json', settingsFile: 'settings.json', instructionsName: 'CLAUDE.md' } as const;

/** The most project folders a scan lists; a person with more sees the first of them. */
const PROJECT_FOLDERS_LIMIT = 200;

/**
 * The project folders Claude keeps state for: the keys of `projects` in `~/.claude.json`. Names only — the values under each
 * key are never looked at. Absolute paths with no control character, in the host's order, bounded.
 */
function projectFolders(mcp: KitHostDocumentRead | undefined): readonly string[] {
  if (mcp?.kind !== 'text') return [];
  let projects: unknown;
  try {
    const document: unknown = mcp.text.trim() === '' ? {} : JSON.parse(mcp.text);
    projects = isRecord(document) ? document.projects : undefined;
  } catch {
    return [];
  }
  if (!isRecord(projects)) return [];
  return Object.keys(projects)
    .filter(path => path.startsWith('/') && [...path].every(character => (character.codePointAt(0) ?? 0) >= 0x20))
    .slice(0, PROJECT_FOLDERS_LIMIT);
}

/** Where Claude keeps its user-scope MCP servers: `mcpServers` in `.claude.json`. */
const mcpImport = {
  document: 'mcp',
  format: 'json',
  file: '.claude.json',
  table: 'mcpServers',
  knownKeys: ['type', 'command', 'args', 'env', 'url'],
  skipDisabled: false,
} as const;

async function scanHost(input: KitHostScanInput): Promise<KitHostSetup> {
  const named = input.configuredHome?.trim() ?? '';
  const configured = named !== '' && isAbsolute(named) ? named : undefined;
  const home = configured ?? join(input.userHome, '.claude');
  const [instructions, settings, mcp, skills] = await Promise.all([
    input.read(home, join(home, 'CLAUDE.md')),
    input.read(home, join(home, 'settings.json')),
    configured === undefined ? input.readUserMcp() : input.read(home, join(home, '.claude.json')),
    input.skills(home, join(home, 'skills')),
  ]);
  const login = await input.login();
  const projectInstructions = await input.projectInstructions(mcp);
  return {
    login,
    instructions,
    settings,
    mcp,
    projectInstructions,
    skills: skills.found,
    problems: [
      ...(named !== '' && configured === undefined
        ? [`CLAUDE_CONFIG_DIR is the relative path "${named}", so ${home} was read instead.`]
        : []),
      ...skills.problems,
    ],
  };
}

function harvest(input: KitHarvestInput): KitHarvestParts {
  const { rest } = input;
  // Hooks are counted so the screen can say "found N, not imported", and dropped: Ferretry runs none of the host's.
  const counted =
    isRecord(rest.hooks) && Object.keys(rest.hooks).length > 0
      ? { source: input.source, count: input.countHooks(rest.hooks) }
      : undefined;
  delete rest.hooks;
  const claudeEnv = input.skippedEnv ? undefined : input.importEnvironment(rest.env, 'env.', importSetup.settingsFile);
  delete rest.env;
  return {
    hooks: counted,
    envImport: claudeEnv,
    modelEnvironment:
      !input.skippedEnv && !input.skippedModelSet && isRecord(input.parsedEnv) ? input.parsedEnv : undefined,
    mcpSource: input.mcpSource ?? '.claude.json',
  };
}

function loginNote(login: KitHostLogin): string {
  const label = 'Claude Code';
  const own = 'claude';
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

/** Claude's host scan, import decisions and login notes; host reads and secret handling remain guarded by Runtimes. */
export const claudeImportKit: RuntimesHarnessKit = {
  scanHost,
  importSetup,
  mcpImport,
  projectFolders,
  harvest,
  loginNote,
};
