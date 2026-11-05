/**
 * An MCP server the machine inventory lists, turned into the setup a local copy previews and applies. Pure.
 *
 * It is `shared-catalogs/mcp-source.ts`'s conversion with ONE difference that matters: NO VALUE IS CARRIED.
 * That conversion refuses a server whose environment value uses `${…}` or looks like a key; a copy from this
 * machine instead turns EVERY environment value into a whole `${secret:NAME}` placeholder (NAME is the variable's own
 * name), because nothing in an inventory says which values are secret and a value is never worth the risk. The
 * person binds each placeholder to one of their own secrets at apply, or leaves it unbound. An address's
 * credentials (a user name or password, a query parameter that is or announces a key) are left out of it and
 * said, never turned into a placeholder, because the contract's address field cannot hold one.
 *
 * The contract is still the last word: the finished setup is parsed through `CatalogMcpSetupSchema`, whose
 * messages are static, so a refusal never echoes a value.
 */
import {
  announcesKey,
  CATALOG_MCP_MAX_ARGS,
  CATALOG_MCP_MAX_COMMAND_CHARS,
  CATALOG_MCP_MAX_ENV,
  CATALOG_MCP_MAX_TEXT_CHARS,
  type CatalogMcpSetup,
  CatalogMcpSetupSchema,
  type CatalogSourceProblem,
  holdsRawKey,
  type LocalMcpOrigin,
  SecretNameSchema,
  SessionMcpEnvNameSchema,
} from '@ferretry/protocol';
import { foldedForScan } from '../catalog-installs/conservative-changes.ts';
import { firstArgumentCredential, readableViews } from '../local-skill-installs/credentials.ts';
import { type McpComponentRecord, type McpSourceServer, mcpSetupOf } from '../shared-catalogs/mcp-source.ts';

/** A server the inventory lists, with where it was found. */
export interface LocalMcpInventoryServer extends McpSourceServer {
  /** The registered project whose file declares it. */
  readonly project?: { readonly root: string } | undefined;
  /** The runtimes (account homes) that load it. */
  readonly runtimes: readonly string[];
}

export type CopiableMcp =
  | {
      readonly ok: true;
      readonly name: string;
      /** The setup, every environment value a whole `${secret:NAME}` placeholder. */
      readonly setup: CatalogMcpSetup;
      readonly placeholders: readonly string[];
      readonly skipped: readonly CatalogSourceProblem[];
      readonly origin: LocalMcpOrigin;
    }
  | { readonly ok: false; readonly reason: string };

const PLAIN_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;

/** A name worth showing: plain characters only, so a hostile one cannot reach a screen. */
const shown = (name: string): string => (PLAIN_NAME.test(name) ? name : 'a variable with an unusual name');

/** The most times a piece of an address is percent-decoded: enough for a doubly encoded name, bounded for a hostile one. */
const MAX_DECODE_ROUNDS = 3;

/**
 * Every form of an address piece a reader could take it for: as written, then percent-decoded (a `+` is a space)
 * up to {@link MAX_DECODE_ROUNDS} times. `null` when the first decoding is malformed, because a piece nobody can read
 * the same way twice is not one to vouch for. A later round that cannot decode is just where the piece stops
 * (`100%25` is a literal percent sign, not a credential).
 */
function decodedForms(piece: string): readonly string[] | null {
  const forms = [piece];
  let current = piece.replaceAll('+', ' ');
  if (current !== piece) forms.push(current);
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return round === 0 ? null : forms;
    }
    if (next === current) return forms;
    forms.push(next);
    current = next;
  }
  return forms;
}

/** Whether a query pair announces or holds a key in any spelling it can be read as; `null` when it cannot be read. */
function pairLooksLikeKey(pair: string): boolean | null {
  const equals = pair.indexOf('=');
  const name = equals === -1 ? pair : pair.slice(0, equals);
  const value = equals === -1 ? '' : pair.slice(equals + 1);
  const names = decodedForms(name);
  const values = decodedForms(value);
  if (names === null || values === null) return null;
  const spellings = names.flatMap(decodedName => values.map(decodedValue => [decodedName, decodedValue] as const));
  return spellings.some(
    ([decodedName, decodedValue]) => announcesName(decodedName) || holdsKey(`${decodedName} ${decodedValue}`),
  );
}

/** Whether `text` holds a raw key, as written or with look-alike and invisible characters folded (the contract reads it raw). */
const holdsKey = (text: string): boolean => holdsRawKey(text) || holdsRawKey(foldedForScan(text));

const announcesName = (name: string): boolean => announcesKey(name) || announcesKey(foldedForScan(name));

/**
 * Whether a piece of an address (a host, a path segment, an identifier) holds a key in any spelling it can be read
 * as: percent-decoded, JSON- or Unicode-unescaped, look-alikes folded. A piece that cannot be read is refused, never
 * kept: nobody can say what it holds.
 */
function pieceHoldsKey(piece: string): boolean {
  const forms = decodedForms(piece);
  if (forms === null) return true;
  return forms.flatMap(form => readableViews(form)).some(holdsKey);
}

/** The address without its credentials, and what was left out. A query piece that announces or holds a key goes. */
function cleanAddress(url: string): {
  readonly url: string;
  readonly problems: readonly CatalogSourceProblem[];
  /** Whether a query piece or the fragment was left out as a key: the credential kinds, not a user name. */
  readonly holdsKey: boolean;
  /** Whether the host or a path segment holds a key. It cannot be left out (it is where the server is), so the copy is refused. */
  readonly addressKey: boolean;
} {
  const match = /^(https?:\/\/)([^/?#]*)([\s\S]*)$/iu.exec(url);
  if (match === null) return { url, problems: [], holdsKey: false, addressKey: false };
  const [, written = '', authority = '', rest = ''] = match;
  const scheme = written.toLowerCase();
  const problems: CatalogSourceProblem[] = [];
  const at = authority.lastIndexOf('@');
  if (at !== -1)
    problems.push({ subject: 'url', reason: 'a user name or password in the address was left out, not copied' });
  const host = at === -1 ? authority : authority.slice(at + 1);
  const queryAt = rest.search(/[?#]/u);
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const tail = queryAt === -1 ? '' : rest.slice(queryAt);
  const hashAt = tail.indexOf('#');
  const query = tail.startsWith('?') ? tail.slice(1, hashAt === -1 ? undefined : hashAt) : '';
  const fragment = hashAt === -1 ? '' : tail.slice(hashAt);
  const addressKey = pieceHoldsKey(host) || path.split('/').some(pieceHoldsKey);
  const pairs = query === '' ? [] : query.split('&');
  let keyLike = 0;
  let unreadable = 0;
  const kept = pairs.filter(pair => {
    const looks = pairLooksLikeKey(pair);
    if (looks === null) unreadable += 1;
    else if (looks) keyLike += 1;
    return looks === false;
  });
  if (keyLike > 0)
    problems.push({
      subject: 'url',
      reason: `${keyLike} query parameter${keyLike === 1 ? '' : 's'} that look like keys ${keyLike === 1 ? 'was' : 'were'} left out of the address, not copied`,
    });
  if (unreadable > 0)
    problems.push({
      subject: 'url',
      reason: `${unreadable} query parameter${unreadable === 1 ? '' : 's'} with a malformed percent-encoding ${unreadable === 1 ? 'was' : 'were'} left out of the address, not copied`,
    });
  const fragmentForms = fragment === '' ? [] : decodedForms(fragment.slice(1));
  const keptFragment = fragmentForms?.some(form => holdsKey(form) || holdsKey(`#${form}`)) === false ? fragment : '';
  if (keptFragment !== fragment)
    problems.push({
      subject: 'url',
      reason: 'a fragment that looks like a key, or cannot be read, was left out of the address, not copied',
    });
  return {
    url: `${scheme}${host}${path}${kept.length === 0 ? '' : `?${kept.join('&')}`}${keptFragment}`,
    problems,
    holdsKey: keyLike > 0 || unreadable > 0 || keptFragment !== fragment,
    addressKey,
  };
}

/** The server with its environment taken out and its address cleaned, plus the names the environment had. */
function stripped(server: LocalMcpInventoryServer): {
  readonly bare: McpSourceServer;
  readonly envNames: readonly string[];
  readonly addressProblems: readonly CatalogSourceProblem[];
} {
  const { project: _project, runtimes: _runtimes, ...source } = server;
  const declaration = server.declaration;
  const component = server.component;
  let envNames: string[] = [];
  let addressProblems: readonly CatalogSourceProblem[] = [];
  let bareDeclaration = declaration;
  if (declaration !== null) {
    if (declaration.transport === 'stdio') {
      envNames = Object.keys(declaration.env);
      bareDeclaration = { ...declaration, env: {} };
    } else {
      const cleaned = cleanAddress(declaration.url);
      addressProblems = cleaned.problems;
      bareDeclaration = { ...declaration, url: cleaned.url };
    }
  }
  let bareComponent: McpComponentRecord | undefined = component;
  if (component !== undefined) {
    if (component.url !== undefined) {
      const cleaned = cleanAddress(component.url);
      addressProblems = [...addressProblems, ...cleaned.problems];
      bareComponent = { ...component, url: cleaned.url };
    } else {
      envNames = Object.keys(component.env ?? {});
      bareComponent = { ...component, env: {} };
    }
  }
  return {
    bare: { ...source, declaration: bareDeclaration, component: bareComponent },
    envNames: envNames.toSorted(),
    addressProblems,
  };
}

const originOf = (server: LocalMcpInventoryServer): LocalMcpOrigin => ({
  kind: server.project === undefined ? 'account' : 'project',
  owner: server.project?.root ?? server.runtimes[0] ?? 'this machine',
  harness: server.harness,
  scope: server.scope,
  id: server.id,
});

/**
 * Every command line the server holds, as it launches them: the declaration's and the component record's. A row
 * can carry both and they can differ (a stale materialization, an edited account config), and `mcpSetupOf` copies
 * only one of them by scope, so each is read and a credential in either refuses the copy: none can leak.
 */
function commandLines(server: LocalMcpInventoryServer): readonly (readonly string[])[] {
  const { declaration, component } = server;
  const lines: (readonly string[])[] = [];
  if (declaration?.transport === 'stdio') lines.push([declaration.command, ...declaration.args]);
  if (component?.url === undefined && component?.command !== undefined)
    lines.push([component.command, ...(component.args ?? [])]);
  return lines;
}

const ADDRESS_IN_TEXT = /https?:\/\/\S*/giu;

/**
 * The 1-based place of the first piece with an address in it whose query or fragment holds a key, read as a direct
 * address is: in the piece as written and with its quoting taken off, so a scheme in capitals, an escaped quote or
 * a `\uXXXX` escape hides nothing.
 */
function firstAddressKey(pieces: readonly string[]): number | undefined {
  const at = pieces.findIndex(piece =>
    readableViews(piece).some(view =>
      [...view.matchAll(ADDRESS_IN_TEXT)].some(address => {
        const cleaned = cleanAddress(address[0]);
        return cleaned.holdsKey || cleaned.addressKey;
      }),
    ),
  );
  return at === -1 ? undefined : at + 1;
}

/**
 * Every address and client identifier the server holds, as it reaches the written config: the declaration's and the
 * component record's (both are read, as for the command lines). A direct address is not an argument, so it is read
 * here: its host and path segments, and the identifier, in every spelling they can be read as.
 */
function directFields(server: LocalMcpInventoryServer): {
  readonly urls: readonly string[];
  readonly ids: readonly string[];
} {
  const { declaration, component } = server;
  const urls: string[] = [];
  const ids: string[] = [];
  if (declaration !== null && declaration.transport !== 'stdio') {
    urls.push(declaration.url);
    if (declaration.oauth !== undefined) ids.push(declaration.oauth.clientId);
  }
  if (component?.url !== undefined) urls.push(component.url);
  if (component?.oauth !== undefined) ids.push(component.oauth.clientId);
  return { urls, ids };
}

/** Whether a direct address's host or path, or an OAuth client identifier, holds a key. Said whole, never stripped. */
function directFieldsHoldKey(server: LocalMcpInventoryServer): boolean {
  const { urls, ids } = directFields(server);
  return urls.some(url => cleanAddress(url).addressKey) || ids.some(pieceHoldsKey);
}

/** The place of the first command piece that holds a credential: in the text, or in the query of an address. */
function firstCommandCredential(pieces: readonly string[]): number | undefined {
  const places = [firstArgumentCredential(pieces), firstAddressKey(pieces)].filter(place => place !== undefined);
  return places.length === 0 ? undefined : Math.min(...places);
}

/** Whether the command or an argument is longer, or there are more arguments, than the contract holds: said before any is read. */
const exceedsContract = (pieces: readonly string[]): boolean =>
  pieces.length > CATALOG_MCP_MAX_ARGS + 1 ||
  pieces.some(
    (piece, index) => piece.length > (index === 0 ? CATALOG_MCP_MAX_COMMAND_CHARS : CATALOG_MCP_MAX_TEXT_CHARS),
  );

/** What can be copied of `server`, or the sentence for why none of it can. */
export function copiableMcp(server: LocalMcpInventoryServer): CopiableMcp {
  const lines = commandLines(server);
  if (lines.some(exceedsContract))
    return {
      ok: false,
      reason:
        'Its command or an argument is longer, or it has more arguments, than a server here holds. Shorten that server, then copy it.',
    };
  const credential = lines.map(firstCommandCredential).find(place => place !== undefined);
  if (credential !== undefined)
    return {
      ok: false,
      reason: `${credential === 1 ? 'Its command' : `Its argument ${credential - 1}`} holds what looks like a password or key, and an argument is copied as it stands. Take it out of that server, then copy it.`,
    };
  if (directFieldsHoldKey(server))
    return {
      ok: false,
      reason:
        'Its address (the host or the path) or its OAuth client identifier holds what looks like a key, and those are copied as they stand. Take it out of that server, then copy it.',
    };
  const { bare, envNames, addressProblems } = stripped(server);
  const converted = mcpSetupOf(bare);
  if (!converted.ok) return { ok: false, reason: converted.reason };
  const skipped: CatalogSourceProblem[] = [...converted.problems, ...addressProblems];
  let setup: CatalogMcpSetup = converted.setup;
  const placeholders: string[] = [];
  if (setup.transport === 'command') {
    const env: Record<string, string> = {};
    for (const name of envNames) {
      if (!SessionMcpEnvNameSchema.safeParse(name).success || !SecretNameSchema.safeParse(name).success) {
        skipped.push({
          subject: `environment ${shown(name)}`,
          reason:
            'not copied: its name is not one a secret placeholder can have (upper-case letters, digits and _, starting with a letter)',
        });
        continue;
      }
      if (placeholders.length >= CATALOG_MCP_MAX_ENV) {
        skipped.push({
          subject: `environment ${shown(name)}`,
          reason: `not copied: a server here holds at most ${CATALOG_MCP_MAX_ENV} environment variables`,
        });
        continue;
      }
      env[name] = `\${secret:${name}}`;
      placeholders.push(name);
    }
    setup = { ...setup, env };
  }
  // Only the environment differs from what `mcpSetupOf` already parsed, and a whole placeholder is always valid.
  const checked = CatalogMcpSetupSchema.parse(setup);
  return { ok: true, name: server.name, setup: checked, placeholders, skipped, origin: originOf(server) };
}
