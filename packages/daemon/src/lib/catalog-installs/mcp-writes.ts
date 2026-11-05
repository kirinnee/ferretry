/**
 * Writing ONE MCP server where the catalog installer and the copy-from-this-machine installer both put it
 * (docs/catalogs.md § The installer, § Copying an MCP server from this machine): into a project's `.mcp.json` through
 * the session-MCP file port (compare-and-swap, no link followed), or as one fleet `mcp` component. The two installers
 * keep their own records and refusal codes; the writing, and the rules for how a placeholder becomes a value, are
 * here so there is exactly one of each.
 *
 * Pure but for the ports it is handed: the caller passes the refusal it raises (`conflict`), the hash it records
 * with, and the words it uses for what it did (`install`/`installed`, or `copy`/`copied`).
 */
import { posix } from 'node:path';
import {
  type CatalogMcpSetup,
  type CatalogSecretBindings,
  type FleetComponentInput,
  mcpServerRefusal,
  type SessionMcpServer,
} from '@ferretry/protocol';
import { type McpProjectFiles, McpProjectFileChanged } from '../session-mcp/service.ts';
import {
  McpProjectFileError,
  parseMcpProjectFile,
  projectEntry,
  renderMcpProjectFile,
} from '../session-mcp/project-file.ts';

const SECRET_PLACEHOLDER = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/u;
const ENV_VARIABLE = /^[A-Z_][A-Z0-9_]*$/u;
export const PROJECT_MCP_FILE = '.mcp.json';

const UNBOUND_NOTE = (placeholder: string): string =>
  `${placeholder} is not set by this install. The program runs without it unless its own environment already has a variable of that name.`;

/** What an installer says about itself: `install`/`installed` or `copy`/`copied`. */
interface McpWriteWords {
  readonly noun: 'install' | 'copy';
  readonly past: 'installed' | 'copied';
}

/** How an installer refuses and hashes: its own error code, and the digest its records use. */
export interface McpWriteContext extends McpWriteWords {
  conflict(message: string): never;
  hash(text: string): Promise<string>;
}

export const withoutTrailingSlash = (path: string): string => posix.normalize(path).replace(/(?<=.)\/+$/u, '');

/** The setup's server with every environment value passed through `value`; one that answers `undefined` is left out. */
function serverOf(setup: CatalogMcpSetup, value: (text: string) => string | undefined): SessionMcpServer {
  if (setup.transport === 'url') return { transport: 'url', url: setup.url, oauth: setup.auth === 'oauth' };
  return {
    transport: 'command',
    command: setup.command,
    args: [...setup.args],
    env: Object.fromEntries(
      Object.entries(setup.env).flatMap(([name, text]) => {
        const written = value(text);
        return written === undefined ? [] : [[name, written]];
      }),
    ),
  };
}

/**
 * The server a PROJECT gets: a placeholder bound to one of the person's variables becomes `${VARIABLE}`, which
 * `.mcp.json` reads from the environment; an unbound one is left out. What was said is added to `notes`.
 */
export function projectServerOf(
  name: string,
  setup: CatalogMcpSetup,
  bindings: CatalogSecretBindings,
  notes: string[],
): SessionMcpServer {
  return serverOf(setup, value => {
    const placeholder = SECRET_PLACEHOLDER.exec(value)?.[1];
    if (placeholder === undefined) return value;
    const variable = bindings[placeholder];
    if (!variable) {
      notes.push(UNBOUND_NOTE(placeholder));
      return undefined;
    }
    notes.push(
      `${name} reads \${${variable}} from its environment. A project's ${PROJECT_MCP_FILE} cannot use Ferretry's secrets, so give the ferret a variable called ${variable}.`,
    );
    return `\${${variable}}`;
  });
}

/** The component a RUNTIME gets, or the sentence for why a login cannot hold it. A bound placeholder becomes `${secret:NAME}`. */
export function runtimeComponentOf(
  setup: CatalogMcpSetup,
  bindings: CatalogSecretBindings,
  notes: string[],
): { readonly component: Extract<FleetComponentInput, { kind: 'mcp' }> } | { readonly refusal: string } {
  const server = serverOf(setup, value => {
    const placeholder = SECRET_PLACEHOLDER.exec(value)?.[1];
    if (placeholder === undefined) return value;
    const secret = bindings[placeholder];
    if (!secret) {
      notes.push(UNBOUND_NOTE(placeholder));
      return undefined;
    }
    return `\${secret:${secret}}`;
  });
  const refusal = mcpServerRefusal('login', server);
  if (refusal !== null) return { refusal };
  return {
    component:
      server.transport === 'url'
        ? { kind: 'mcp', url: server.url, ...(server.oauth ? { auth: 'oauth' as const } : {}) }
        : {
            kind: 'mcp',
            command: server.command,
            args: [...server.args],
            ...(Object.keys(server.env).length === 0 ? {} : { env: { ...server.env } }),
          },
  };
}

/** The project's `.mcp.json` as it reads now, parsed. A file that cannot be parsed is a conflict, never repaired. */
export async function readProjectMcp(files: McpProjectFiles, root: string, context: McpWriteContext) {
  const path = posix.join(withoutTrailingSlash(root), PROJECT_MCP_FILE);
  try {
    const reading = await files.read(path);
    return { path, reading, document: parseMcpProjectFile(reading.text) };
  } catch (error) {
    if (error instanceof McpProjectFileError) return context.conflict(error.message);
    throw error;
  }
}

/** The entry's hash as read (`null` when there is none), and again as `entry` when it is not the one a record wrote. */
export async function checkProjectMcp(
  files: McpProjectFiles,
  root: string,
  name: string,
  recorded: string | undefined,
  context: McpWriteContext,
): Promise<{ seen: string | null; entry?: string }> {
  const { document } = await readProjectMcp(files, root, context);
  const servers = document.mcpServers as Record<string, unknown> | undefined;
  if (servers === undefined || !Object.hasOwn(servers, name)) return { seen: null };
  if (recorded === undefined)
    context.conflict(
      `${PROJECT_MCP_FILE} already has a server called ${name} that no ${context.noun} of ours put there.`,
    );
  const now = await context.hash(JSON.stringify(servers[name]));
  return now === recorded ? { seen: now } : { seen: now, entry: now };
}

/**
 * Sets `name` in the file, only if the entry checked earlier (`verifiedEntry`) is still the one just read, and
 * only while the file is as read (the port's etag). Answers the entry's hash, for the record.
 */
export async function writeProjectMcp(
  files: McpProjectFiles,
  root: string,
  name: string,
  server: SessionMcpServer,
  verifiedEntry: string | null,
  context: McpWriteContext,
): Promise<{ sha256: string }> {
  const { path, reading, document } = await readProjectMcp(files, root, context);
  const entry = projectEntry(server);
  const servers = (document.mcpServers ?? {}) as Record<string, unknown>;
  const now = Object.hasOwn(servers, name) ? await context.hash(JSON.stringify(servers[name])) : null;
  if (now !== verifiedEntry)
    context.conflict(
      `${PROJECT_MCP_FILE} changed while the ${context.noun} was being applied, so nothing was written. Preview it again.`,
    );
  const text = renderMcpProjectFile({ ...document, mcpServers: { ...servers, [name]: entry } });
  try {
    await files.replace(path, text, reading.etag);
  } catch (error) {
    if (error instanceof McpProjectFileChanged) context.conflict(error.message);
    throw error;
  }
  return { sha256: await context.hash(JSON.stringify(entry)) };
}

/** Removes `entry` from the file, refusing if it is no longer what the record hashed. An entry already gone is done. */
export async function removeProjectMcp(
  files: McpProjectFiles,
  root: string,
  entry: string,
  recorded: string,
  context: McpWriteContext,
): Promise<void> {
  const { path, reading, document } = await readProjectMcp(files, root, context);
  const servers = (document.mcpServers ?? {}) as Record<string, unknown>;
  if (!Object.hasOwn(servers, entry)) return;
  if ((await context.hash(JSON.stringify(servers[entry]))) !== recorded)
    context.conflict(
      `The server ${entry} in ${PROJECT_MCP_FILE} was edited on this machine since it was ${context.past}, so it was not removed.`,
    );
  const { [entry]: _removed, ...rest } = servers;
  try {
    await files.replace(path, renderMcpProjectFile({ ...document, mcpServers: rest }), reading.etag);
  } catch (error) {
    if (error instanceof McpProjectFileChanged) context.conflict(error.message);
    throw error;
  }
}

/**
 * The sentence for why `bindings` do not fit `placeholders`, or `undefined` when they do: every placeholder is
 * said (bound to one of the person's own secrets, or `null`), nothing else is, each secret is one they hold,
 * and a project's `.mcp.json` can only read a variable, so its secret must be named like one.
 */
export function bindingsRefusal(
  placeholders: readonly string[],
  bindings: CatalogSecretBindings,
  own: ReadonlySet<string>,
  scope: 'project' | 'runtime',
  what: string,
): string | undefined {
  const given = Object.keys(bindings);
  const missing = placeholders.filter(name => !given.includes(name));
  if (missing.length > 0)
    return `Say what to do with ${missing.join(', ')}: bind each one to a secret of yours, or leave it unbound.`;
  const extra = given.filter(name => !placeholders.includes(name));
  if (extra.length > 0)
    return `${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not something ${what} asks for.`;
  for (const [placeholder, secret] of Object.entries(bindings))
    if (secret !== null && !own.has(secret))
      return `You have no secret called ${secret}, so ${placeholder} cannot use it.`;
  if (scope !== 'project') return undefined;
  for (const secret of Object.values(bindings))
    if (secret !== null && !ENV_VARIABLE.test(secret))
      return `A project's ${PROJECT_MCP_FILE} can only read an environment variable, and ${secret} is not a name one can have (upper-case letters, digits and _). Install it into a runtime, or pick a secret with such a name.`;
  return undefined;
}
