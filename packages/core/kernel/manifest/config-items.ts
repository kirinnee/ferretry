/**
 * The item verbs of a configuration collection (`ls`, `show`, `add`, `edit`, `rm`): what `fy mcp add`, `fy harness
 * claude-code settings edit` and the other component verbs run (docs/config-files.md; parity rows V-0183 … V-0188).
 *
 * An item IS a file — `<collection>/<name>.yaml` — so every verb is composed over the Kernel's own configuration routes
 * through the plugin's client: the list is `GET /v1/config/status`, a read is `GET /v1/config/file`, an add or edit is
 * `PUT /v1/config/file` against the etag the item was read at, a removal is `DELETE /v1/config/file` with that etag.
 * The verbs hold NO rule of their own: the daemon checks the item against its schema, holds an edit that loosens for the
 * owner, refuses a raw secret, and shows a hidden value as `‹hidden›` and keeps it as it is, so a verb that edits only
 * the keys it was given can neither leak nor wipe one. An edit that changes nothing is said, not written.
 *
 * Which keys a flag sets is the plugin's (`keys`): `mcp` maps `--command`, `--arg`, `--url` and `--env`; the settings
 * and hooks collections take their whole text from `--file`. Pure of I/O beyond the client and terminal it is handed.
 */
import { editConfigText, readConfigText } from '@ferretry/std/yaml';
import type { CliContext, VerbHandler, VerbInvocation } from './implement.ts';
import type { Manifest } from './types.ts';

/** The terminal's exit codes this uses: success, a refusal, a mistake in how the verb was typed. */
const OK = 0;
const FAILED = 1;
const USAGE = 2;

/** A flag-edited key set: what `add` and `edit` do beyond taking a whole `--file`. */
export interface ConfigItemKeys {
  /** The flags this collection takes (`command`, `arg`, …) — anything else typed is refused, not ignored. */
  readonly flags: readonly string[];
  /**
   * The item's text after the flags are applied to `current` (the shown text; a new item's starter). Throws an `Error`
   * whose message is said as it is. Returns the text unchanged when nothing was asked.
   */
  apply(current: string, flags: Readonly<Record<string, readonly string[]>>): string;
}

export interface ConfigItemSpec {
  /** The collection folder under `config/`: `mcp`, `claude-code/settings`. */
  readonly collection: string;
  /** What one item is called in a sentence: `MCP server`, `Claude Code settings item`. */
  readonly noun: string;
  /** The verb prefix a person types, for the sentences that name the next command: `mcp`, `harness codex settings`. */
  readonly verbPrefix: string;
  readonly client: CliContext<Manifest>['client'];
  readonly io: CliContext<Manifest>['io'];
  readonly readText: CliContext<Manifest>['readText'];
  readonly confirm: CliContext<Manifest>['confirm'];
  /** The binary's name, for the sentences that name a command; `fy` when left out. */
  readonly binary?: string;
  /** What `--env`, `--arg` … set; absent, only `--file` supplies a text. */
  readonly keys?: ConfigItemKeys;
}

export interface ConfigItemVerbs {
  readonly ls: VerbHandler;
  readonly show: VerbHandler;
  readonly add: VerbHandler;
  readonly edit: VerbHandler;
  readonly rm: VerbHandler;
}

interface FileView {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string;
  readonly etag: string;
  readonly state?: string;
  readonly issues?: readonly {
    readonly path: string;
    readonly line?: number;
    readonly column?: number;
    readonly severity: string;
    readonly message: string;
    readonly fix?: string;
  }[];
}

interface Status {
  readonly files: readonly { readonly path: string; readonly state: string }[];
}

interface PutResult {
  readonly etag: string;
  readonly outcome: 'applied' | 'pending' | 'removed';
  readonly pending?: { readonly changes: readonly string[] };
}

/** The component flags today's `fy` took; each collection takes the ones its `keys` name and refuses the rest. */
const V4_ONLY_FLAGS = ['command', 'arg', 'url', 'env', 'flag', 'item', 'model', 'default', 'harness'] as const;

/** An item's name as typed: one path segment, never a way out of the collection. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const on = (invocation: VerbInvocation, name: string): boolean => {
  const value = invocation.options[name];
  return value === true || value === 'true';
};

/** Every value of a repeatable flag, in the order typed. */
const many = (invocation: VerbInvocation, name: string): readonly string[] => {
  const value = invocation.options[name];
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

const one = (invocation: VerbInvocation, name: string): string | undefined => many(invocation, name).at(-1);

const issueLine = (issue: NonNullable<FileView['issues']>[number]): string => {
  const where =
    issue.line === undefined ? issue.path : `${issue.path}:${String(issue.line)}:${String(issue.column ?? 1)}`;
  return `${where} ${issue.severity}: ${issue.message}${issue.fix === undefined ? '' : `\n  fix: ${issue.fix}`}`;
};

/** The located problems a `422 config_invalid` refusal carries, as lines; `undefined` for any other failure. */
const refusedIssues = (error: unknown): readonly string[] | undefined => {
  const body = (error as { readonly body?: unknown } | null)?.body;
  if (typeof body !== 'object' || body === null) return undefined;
  const { error: sentence, issues } = body as { error?: unknown; issues?: unknown };
  if (typeof sentence !== 'string' || !Array.isArray(issues)) return undefined;
  return [...(issues as NonNullable<FileView['issues']>[number][]).map(issueLine), sentence];
};

/** The environment variables an `--env NAME=value` list names; a malformed one is said, not skipped. */
export function parseEnvPairs(pairs: readonly string[]): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0) throw new Error(`--env takes NAME=value, got "${pair}".`);
    env[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return env;
}

/** The item verbs of one collection. */
export function configItemVerbs(spec: ConfigItemSpec): ConfigItemVerbs {
  const bin = spec.binary ?? 'fy';
  const { io, client } = spec;
  const pathOf = (name: string): string => `${spec.collection}/${name}.yaml`;
  const say = (text: string): void => io.out(`${text}\n`);
  const refuse = (text: string, code: number = FAILED): number => {
    io.err(`${text}\n`);
    return code;
  };
  const nameOf = (invocation: VerbInvocation): string | undefined => {
    const name = invocation.args[0];
    return typeof name === 'string' && SAFE_NAME.test(name) ? name : undefined;
  };
  const badName = (invocation: VerbInvocation): number =>
    refuse(
      invocation.args[0] === undefined
        ? `name the ${spec.noun}: \`${bin} ${spec.verbPrefix} <name>\``
        : `"${String(invocation.args[0])}" is not a name a ${spec.noun} can have: use letters, digits, dots and dashes`,
      USAGE,
    );
  const read = async (name: string): Promise<FileView> =>
    await client.call<FileView>('GET /v1/config/file', { query: { path: pathOf(name) } });

  const said = (put: PutResult, applied: string, held: (changes: string) => string): string =>
    put.outcome === 'pending' ? held((put.pending?.changes ?? []).join('; ')) : applied;

  /** Writes `text` over what was read; says the located problems when the daemon refuses it. */
  const write = async (name: string, text: string, etag: string, applied: string): Promise<number> => {
    try {
      const put = await client.call<PutResult>('PUT /v1/config/file', { body: { path: pathOf(name), text, etag } });
      say(
        said(
          put,
          applied,
          changes =>
            `${applied.replace(/\.$/u, '')}, but it waits for your confirmation: ${changes}.\n  confirm: ${bin} config confirm ${pathOf(name)}`,
        ),
      );
      return OK;
    } catch (error) {
      const lines = refusedIssues(error);
      if (lines === undefined) throw error;
      return refuse(lines.join('\n'));
    }
  };

  /** Edit and rm change what every runtime using the item runs with: asked first unless `--yes` (or `--dry-run`). */
  const mayGoAhead = async (invocation: VerbInvocation, question: string): Promise<boolean> => {
    if (on(invocation, 'yes') || on(invocation, 'dry-run')) return true;
    if (spec.confirm !== undefined && (await spec.confirm(question))) return true;
    io.err(`${question} Nothing was changed; run it again with --yes to go ahead.\n`);
    return false;
  };

  const flagsOf = (invocation: VerbInvocation): Readonly<Record<string, readonly string[]>> =>
    Object.fromEntries((spec.keys?.flags ?? []).map(flag => [flag, many(invocation, flag)] as const));

  /** The text a verb was asked to write: `--file`, the flags applied to `current`, or nothing (`undefined`). */
  const requested = async (invocation: VerbInvocation, current: string): Promise<string | undefined> => {
    const file = one(invocation, 'file');
    const flags = flagsOf(invocation);
    const flagged = Object.values(flags).some(values => values.length > 0);
    if (file !== undefined && flagged) throw new Error('give the item as --file, or as flags — not both.');
    if (file !== undefined) {
      if (spec.readText === undefined)
        throw new Error('this terminal cannot read a file; pipe the text in with --file -');
      return await spec.readText(file);
    }
    if (flagged) return (spec.keys as ConfigItemKeys).apply(current, flags);
    return undefined;
  };

  /** A flag today's component verbs took that this collection's items do not hold: refused, never silently dropped. */
  const stray = (invocation: VerbInvocation): string | undefined => {
    const held = new Set(spec.keys?.flags ?? []);
    const found = V4_ONLY_FLAGS.find(flag => !held.has(flag) && invocation.options[flag] !== undefined);
    return found === undefined ? undefined : `A ${spec.noun} has no --${found}: ${flagWords()}.`;
  };

  const flagWords = (): string =>
    spec.keys === undefined ? '--file <path>' : `--file <path>, ${spec.keys.flags.map(flag => `--${flag}`).join(', ')}`;

  return {
    ls: async invocation => {
      const status = await client.call<Status>('GET /v1/config/status');
      const items = status.files
        .filter(file => file.path.startsWith(`${spec.collection}/`) && file.path.endsWith('.yaml'))
        .map(file => ({
          name: file.path.slice(spec.collection.length + 1, -'.yaml'.length),
          path: file.path,
          state: file.state,
        }))
        .filter(item => !item.name.includes('/'))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (on(invocation, 'json')) say(JSON.stringify({ items }, null, 2));
      else if (items.length === 0)
        say(`No ${spec.noun} items yet. Add one with \`${bin} ${spec.verbPrefix} add <name>\`.`);
      else for (const item of items) say(item.state === 'ok' ? item.name : `${item.name}  (${item.state})`);
      return OK;
    },

    show: async invocation => {
      const name = nameOf(invocation);
      if (name === undefined) return badName(invocation);
      const view = await read(name);
      if (!view.exists)
        return refuse(`There is no ${spec.noun} ${name}. See them all with \`${bin} ${spec.verbPrefix} ls\`.`);
      if (on(invocation, 'json')) say(JSON.stringify(view, null, 2));
      else
        say(
          [
            `${view.path} (${view.state ?? 'ok'})`,
            `etag: ${view.etag}`,
            ...(view.issues ?? []).map(issueLine),
            '',
            view.text,
          ].join('\n'),
        );
      return OK;
    },

    add: async invocation => {
      const name = nameOf(invocation);
      if (name === undefined) return badName(invocation);
      const wrong = stray(invocation);
      if (wrong !== undefined) return refuse(wrong, USAGE);
      const view = await read(name);
      if (view.exists)
        return refuse(
          `There is already a ${spec.noun} ${name}. Change it with \`${bin} ${spec.verbPrefix} edit ${name}\`.`,
        );
      let text: string | undefined;
      try {
        text = await requested(invocation, view.text);
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error), USAGE);
      }
      if (text === undefined) return refuse(`Say what the ${spec.noun} is: ${flagWords()}.`, USAGE);
      if (on(invocation, 'dry-run')) {
        say(`Would add ${spec.noun} ${name} (${pathOf(name)}).`);
        return OK;
      }
      return await write(name, text, view.etag, `Added ${spec.noun} ${name}.`);
    },

    edit: async invocation => {
      const name = nameOf(invocation);
      if (name === undefined) return badName(invocation);
      const wrong = stray(invocation);
      if (wrong !== undefined) return refuse(wrong, USAGE);
      const view = await read(name);
      if (!view.exists)
        return refuse(
          `There is no ${spec.noun} ${name} to edit. Add it with \`${bin} ${spec.verbPrefix} add ${name}\`.`,
        );
      let text: string | undefined;
      try {
        text = await requested(invocation, view.text);
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error), USAGE);
      }
      if (text === undefined) return refuse(`Say what to change: ${flagWords()}.`, USAGE);
      if (text === view.text) {
        say(`${spec.noun} ${name} is already like that; nothing was changed.`);
        return OK;
      }
      if (on(invocation, 'dry-run')) {
        say(`Would change ${spec.noun} ${name} (${pathOf(name)}).`);
        return OK;
      }
      if (
        !(await mayGoAhead(
          invocation,
          `Change ${spec.noun} ${name}? Every profile and runtime that uses it changes too.`,
        ))
      )
        return FAILED;
      return await write(name, text, view.etag, `Changed ${spec.noun} ${name}.`);
    },

    rm: async invocation => {
      const name = nameOf(invocation);
      if (name === undefined) return badName(invocation);
      if (on(invocation, 'remove-from-profiles'))
        return refuse(
          `--remove-from-profiles is not available yet: take ${name} out of each profile's contents first (\`${bin} config status\` lists the profiles), then remove it.`,
          USAGE,
        );
      const view = await read(name);
      if (!view.exists)
        return refuse(`There is no ${spec.noun} ${name}. See them all with \`${bin} ${spec.verbPrefix} ls\`.`);
      if (on(invocation, 'dry-run')) {
        say(`Would remove ${spec.noun} ${name} (${pathOf(name)}).`);
        return OK;
      }
      if (
        !(await mayGoAhead(
          invocation,
          `Remove ${spec.noun} ${name}? A profile that still lists it will report it missing.`,
        ))
      )
        return FAILED;
      try {
        const put = await client.call<PutResult>('DELETE /v1/config/file', {
          query: { path: pathOf(name), etag: view.etag },
        });
        say(
          said(
            put,
            `Removed ${spec.noun} ${name}.`,
            changes =>
              `Removing ${spec.noun} ${name} waits for your confirmation: ${changes}.\n  confirm: ${bin} config confirm ${pathOf(name)}`,
          ),
        );
        return OK;
      } catch (error) {
        const lines = refusedIssues(error);
        if (lines === undefined) throw error;
        return refuse(lines.join('\n'));
      }
    },
  };
}

/**
 * The MCP server item's flag keys (`--command`, `--arg`, `--url`, `--env`): top-level keys of `mcp/<name>.yaml` set on the
 * text with every comment kept. `--url` replaces a command (an item has exactly one of the two) and `--command` a url;
 * `--arg` replaces the whole list; `--env` adds to the variables the item already has, so one the owner wrote stays.
 */
export const MCP_ITEM_KEYS: ConfigItemKeys = {
  flags: ['command', 'arg', 'url', 'env'],
  apply(current, flags) {
    const command = flags.command?.at(-1);
    const url = flags.url?.at(-1);
    const args = flags.arg ?? [];
    const env = parseEnvPairs(flags.env ?? []);
    if (command !== undefined && url !== undefined)
      throw new Error('an MCP server has a --command or a --url, not both.');
    const read = readConfigText(current);
    if (!read.ok) throw new Error('the item does not parse as YAML; fix it at the machine, or replace it with --file.');
    const held = read.read.value;
    const now: Record<string, unknown> =
      typeof held === 'object' && held !== null && !Array.isArray(held) ? { ...held } : {};
    const target: Record<string, unknown> = { ...now };
    if (command !== undefined) {
      target.command = command;
      delete target.url;
    }
    if (url !== undefined) {
      target.url = url;
      delete target.command;
      if (args.length === 0) delete target.args;
    }
    if (args.length > 0) target.args = [...args];
    if (Object.keys(env).length > 0) {
      const kept = now.env;
      target.env = { ...(typeof kept === 'object' && kept !== null && !Array.isArray(kept) ? kept : {}), ...env };
    }
    // Only the scalars that differ are written: a comment, the key order and a hidden value the file holds stay as they are.
    return editConfigText(current, target, now, undefined);
  },
};
