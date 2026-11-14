/**
 * ITEM VERBS OVER THE KERNEL'S CONFIG ROUTES (docs/config-files.md, "components"): `ls`, `show`, `add`, `edit` and `rm`
 * of ONE collection of items (`config/mcp/<name>.yaml`, `config/skills/<name>.yaml`, …), for the plugin that owns it.
 *
 * The item service v4's `fy component …` verbs ran over is, in 5.0, the kernel's own file routes: `GET /v1/config/status`
 * (which files exist), `GET`/`PUT`/`DELETE /v1/config/file` (one file, against the etag it was read at). A plugin that owns
 * a collection declares its kind here — the folder, the words, the flags that build its document — and the verbs and
 * their sentences are one: the same refusals, the same preview, the same "used by" lines for every kind.
 *
 * What an edit touches is the TEXT: `editConfigText` sets only the keys that really changed, so the owner's comments and key
 * order survive, and a value the read hid (`‹hidden›`) is never written back as a mask — it is not a key the edit names.
 * A raw secret is refused by the kernel on write, and an edit that loosens waits for the owner (an item never does today).
 *
 * Pure of the process: the client, the terminal and the confirmation are handed in.
 */
import { ITEM_NAME_PATTERN } from '@ferretry/std';
import { editConfigText, readConfigText } from '@ferretry/std/yaml';
import type { PluginClient, TerminalIo, VerbInvocation } from './implement.ts';

/** A document as the owner's schema holds it: a plain mapping. */
export type ItemDocument = Readonly<Record<string, unknown>>;

/** One collection of items and the words that name it. */
export interface ConfigItemKind {
  /** The folder under `config/`: `mcp`, `claude-code/settings`. */
  readonly collection: string;
  /** What one item is called in a sentence: `MCP server`, `Claude Code settings item`. */
  readonly noun: string;
  /** The word a profile layer names it by (`mcp/<name>` in a profile's `contents`): `mcp`, `skills`, `settings`. */
  readonly layer: string;
  /** The verb a hint names it by: `mcp` → "fy mcp show <name>"; `harness claude-code settings`. */
  readonly command: string;
  /**
   * The whole document the flags say, falling back to `current` on an edit (`undefined` on an add). A flag a person did
   * not give keeps what the item has; a document the schema would refuse is refused by the daemon with its own located
   * sentence, so a kind only says what the flags MEAN.
   */
  fields(invocation: VerbInvocation, current: ItemDocument | undefined): Promise<ItemDocument> | ItemDocument;
  /** The lines `show` prints for one document, besides where it is used. */
  details(document: ItemDocument): readonly string[];
}

/** A refusal in plain words: printed as the error, exit 1. */
export class ItemCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemCommandError';
  }
}

/** What a controller needs from the shell. */
export interface ConfigItemsDeps {
  readonly client: Pick<PluginClient, 'call'>;
  readonly io: TerminalIo;
  /** The binary's name, for hints. */
  readonly binary: string;
  /** A yes/no at the terminal; absent or `false` off a terminal. */
  readonly confirm?: (question: string) => Promise<boolean>;
}

/** Where an item is used: the profiles that name it, and every runtime on those profiles (directly or through a base). */
export interface ItemUsage {
  readonly direct: readonly string[];
  readonly profiles: readonly string[];
  readonly runtimes: readonly string[];
}

const STATUS = 'GET /v1/config/status';
const FILE = 'GET /v1/config/file';
const PUT = 'PUT /v1/config/file';
const DELETE = 'DELETE /v1/config/file';

const EXTENSION = '.yaml';

/** One file the kernel lists. */
export interface StatusFile {
  readonly path: string;
  readonly kind?: string;
  readonly state?: string;
}
/** One file as the kernel reads it out. */
export interface ConfigFileRead {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string;
  readonly etag: string;
}
interface WriteResult {
  readonly outcome: 'applied' | 'pending' | 'removed';
  readonly pending?: { readonly changes: readonly string[] };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const names = (values: readonly string[]): string => (values.length === 0 ? 'none' : values.join(', '));

const indent = (lines: readonly string[]): string[] => lines.map(line => `  ${line}`);

const counted = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** The flag a person gave, last one wins. */
export const itemFlag = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[value.length - 1] as string | undefined) : undefined;
};

/** Every value of a repeatable flag, in the order given. */
export const itemFlagList = (invocation: VerbInvocation, name: string): string[] => {
  const value = invocation.options[name];
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? [...(value as readonly string[])] : [];
};

/** A switch that is on. */
export const itemFlagOn = (invocation: VerbInvocation, ...flagNames: readonly string[]): boolean =>
  flagNames.some(name => invocation.options[name] === true || invocation.options[name] === 'true');

/** `NAME=value` pairs as a mapping; a pair with no name or no `=` is refused. */
export function itemEnvPairs(pairs: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0) throw new ItemCommandError(`--env takes NAME=value, got "${pair}".`);
    env[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return env;
}

/** The mapping a file's text holds, or a refusal that says the file does not parse. */
function documentOf(text: string, path: string): Record<string, unknown> {
  const read = readConfigText(text);
  if (!read.ok)
    throw new ItemCommandError(`${path} does not parse as YAML, so nothing was changed: fix it at the machine.`);
  if (read.read.value === null || read.read.value === undefined) return {};
  if (!isRecord(read.read.value))
    throw new ItemCommandError(`${path} is not a mapping of keys, so nothing was changed.`);
  return read.read.value;
}

/** What a failed call says: a refusal's located issues, or its own sentence. */
function failureWords(cause: unknown): string {
  const body = (cause as { readonly body?: unknown } | null)?.body;
  const issues = isRecord(body) && Array.isArray(body.issues) ? body.issues : [];
  if (isRecord(body) && typeof body.error === 'string' && issues.length > 0) {
    return [
      body.error,
      ...issues.flatMap(issue => {
        if (!isRecord(issue) || typeof issue.message !== 'string') return [];
        const place = `${typeof issue.path === 'string' ? issue.path : ''}${typeof issue.line === 'number' ? `:${String(issue.line)}` : ''}`;
        const fix = typeof issue.fix === 'string' && issue.fix !== '' ? ` (${issue.fix})` : '';
        return [`  ${place} — ${issue.message}${fix}`];
      }),
    ].join('\n');
  }
  const message = cause instanceof Error ? cause.message.trim() : '';
  return message === '' ? 'This machine did not answer.' : message;
}

/** The names of the files of one folder, from the kernel's list of what exists. */
export const namesIn = (files: readonly StatusFile[], folder: string): string[] =>
  files
    .map(file => file.path)
    .filter(
      path => path.startsWith(`${folder}/`) && path.endsWith(EXTENSION) && !path.slice(folder.length + 1).includes('/'),
    )
    .map(path => path.slice(folder.length + 1, -EXTENSION.length))
    .toSorted((left, right) => left.localeCompare(right));

/** The files the kernel lists as existing. */
export async function configFiles(client: Pick<PluginClient, 'call'>): Promise<readonly StatusFile[]> {
  const status = await client.call<{ readonly files?: readonly StatusFile[] }>(STATUS);
  return status.files ?? [];
}

/** One file's text and etag; `exists: false` for one that is not there yet. */
export async function readConfigFile(client: Pick<PluginClient, 'call'>, path: string): Promise<ConfigFileRead> {
  return await client.call<ConfigFileRead>(FILE, { query: { path } });
}

/** The mapping a read file holds ({} for an empty one); a file that does not parse is refused in words. */
export function configDocument(file: Pick<ConfigFileRead, 'path' | 'text'>): ItemDocument {
  return documentOf(file.text, file.path);
}

/**
 * Which profiles and runtimes use what, read once from the files the daemon has: a profile's `contents` and a runtime's
 * `profile`. A profile that has a using profile as a base layer changes with it.
 */
export class UsageIndex {
  private constructor(
    private readonly profiles: ReadonlyMap<string, readonly string[]>,
    private readonly runtimeProfiles: ReadonlyMap<string, string | undefined>,
  ) {}

  static async load(client: Pick<PluginClient, 'call'>, known?: readonly StatusFile[]): Promise<UsageIndex> {
    const files = known ?? (await configFiles(client));
    const profiles = new Map<string, readonly string[]>();
    for (const name of namesIn(files, 'profiles')) {
      const path = `profiles/${name}${EXTENSION}`;
      const document = documentOf((await readConfigFile(client, path)).text, path);
      profiles.set(
        name,
        Array.isArray(document.contents)
          ? document.contents.filter((layer): layer is string => typeof layer === 'string')
          : [],
      );
    }
    const runtimes = new Map<string, string | undefined>();
    for (const name of namesIn(files, 'runtimes')) {
      const path = `runtimes/${name}${EXTENSION}`;
      const document = documentOf((await readConfigFile(client, path)).text, path);
      runtimes.set(name, typeof document.profile === 'string' ? document.profile : undefined);
    }
    return new UsageIndex(profiles, runtimes);
  }

  /** Where `reference` (`mcp/github`) is used. */
  of(reference: string): ItemUsage {
    const direct = [...this.profiles].filter(([, layers]) => layers.includes(reference)).map(([name]) => name);
    const reached = new Set(direct);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, layers] of this.profiles) {
        if (!reached.has(name) && layers.some(layer => layer.startsWith('profile/') && reached.has(layer.slice(8)))) {
          reached.add(name);
          grew = true;
        }
      }
    }
    const runtimes = [...this.runtimeProfiles]
      .filter(([, profile]) => profile !== undefined && reached.has(profile))
      .map(([name]) => name);
    const sorted = (values: Iterable<string>): string[] =>
      [...values].toSorted((left, right) => left.localeCompare(right));
    return { direct: sorted(direct), profiles: sorted(reached), runtimes: sorted(runtimes) };
  }
}

/** The verbs of one kind, over one daemon. */
export class ConfigItems {
  constructor(
    private readonly deps: ConfigItemsDeps,
    private readonly kind: ConfigItemKind,
  ) {}

  private pathOf(name: string): string {
    return `${this.kind.collection}/${name}${EXTENSION}`;
  }

  private referenceOf(name: string): string {
    return `${this.kind.layer}/${name}`;
  }

  private checkedName(name: string | undefined, what: string): string {
    if (name === undefined || name === '') throw new ItemCommandError(`Say which ${what}.`);
    if (!ITEM_NAME_PATTERN.test(name) || name.length > 64)
      throw new ItemCommandError(
        `"${name}" is not a name an item can have: use letters and digits, joined by single dashes.`,
      );
    return name;
  }

  private async put(path: string, text: string, etag: string): Promise<WriteResult> {
    return await this.deps.client.call<WriteResult>(PUT, { body: { path, text, etag } });
  }

  private consequence(usage: ItemUsage): string {
    return usage.profiles.length === 0
      ? 'Nothing uses it yet.'
      : `Changing it changes ${counted(usage.profiles.length, 'profile')}${usage.runtimes.length === 0 ? '' : ` and ${counted(usage.runtimes.length, 'runtime')}`}. Running sessions keep the old version until restarted.`;
  }

  /** `ls`: one line per item, and how to show one. */
  async ls(options: { readonly json: boolean }): Promise<number> {
    const { client, io, binary } = this.deps;
    const files = await configFiles(client);
    const found = namesIn(files, this.kind.collection);
    const index = await UsageIndex.load(client, files);
    if (options.json) {
      const items = found.map(name => ({
        name,
        reference: this.referenceOf(name),
        usedBy: index.of(this.referenceOf(name)),
      }));
      io.out(`${JSON.stringify({ collection: this.kind.collection, items }, null, 2)}\n`);
      return 0;
    }
    if (found.length === 0) {
      io.out(`No ${this.kind.noun}s yet. Add one with \`${binary} ${this.kind.command} add <name>\`.\n`);
      return 0;
    }
    const lines = found.map(
      name => `${name}  used by ${counted(index.of(this.referenceOf(name)).profiles.length, 'profile')}`,
    );
    io.out(`${[...lines, '', `Show one with \`${binary} ${this.kind.command} show <name>\`.`].join('\n')}\n`);
    return 0;
  }

  /** `show <name>`: one item and where it is used. */
  async show(nameArg: string | undefined, options: { readonly json: boolean }): Promise<number> {
    const { client, io, binary } = this.deps;
    const name = this.checkedName(nameArg, `${this.kind.noun} to show`);
    const path = this.pathOf(name);
    const file = await readConfigFile(client, path);
    if (!file.exists)
      throw new ItemCommandError(
        `There is no ${this.kind.noun} ${name}. See them with \`${binary} ${this.kind.command} ls\`.`,
      );
    const document = documentOf(file.text, path);
    const usage = (await UsageIndex.load(client)).of(this.referenceOf(name));
    if (options.json) {
      io.out(`${JSON.stringify({ reference: this.referenceOf(name), path, document, usedBy: usage }, null, 2)}\n`);
      return 0;
    }
    io.out(
      `${[
        this.referenceOf(name),
        ...indent([
          ...this.kind.details(document),
          `Used by profiles: ${names(usage.profiles)}`,
          `Used by runtimes: ${names(usage.runtimes)}`,
          this.consequence(usage),
        ]),
      ].join('\n')}\n`,
    );
    return 0;
  }

  /** `add <name> …`. */
  async add(invocation: VerbInvocation): Promise<number> {
    const { client, binary } = this.deps;
    const name = this.checkedName(invocation.args[0], `${this.kind.noun} to add`);
    const path = this.pathOf(name);
    const file = await readConfigFile(client, path);
    if (file.exists)
      throw new ItemCommandError(
        `${name} is already a ${this.kind.noun}. Change it with \`${binary} ${this.kind.command} edit ${name}\`.`,
      );
    const document = await this.kind.fields(invocation, undefined);
    const text = editConfigText(file.text, { ...document }, {}, undefined);
    return await this.write(
      invocation,
      path,
      text,
      file.etag,
      `Add ${this.kind.noun} ${name}`,
      `Added ${this.kind.noun} ${name}.`,
      false,
    );
  }

  /** `edit <name> …`: keeps what a flag leaves out. */
  async edit(invocation: VerbInvocation): Promise<number> {
    const { client, io, binary } = this.deps;
    const name = this.checkedName(invocation.args[0], `${this.kind.noun} to change`);
    const path = this.pathOf(name);
    const file = await readConfigFile(client, path);
    if (!file.exists)
      throw new ItemCommandError(
        `There is no ${this.kind.noun} ${name} to change. Add it with \`${binary} ${this.kind.command} add ${name}\`.`,
      );
    const current = documentOf(file.text, path);
    const document = await this.kind.fields(invocation, current);
    const text = editConfigText(file.text, { ...document }, current, undefined);
    if (text === file.text) {
      io.out(`${this.kind.noun} ${name} already says that: nothing was changed.\n`);
      return 0;
    }
    const usage = (await UsageIndex.load(client)).of(this.referenceOf(name));
    return await this.write(
      invocation,
      path,
      text,
      file.etag,
      `Change ${this.kind.noun} ${name}\n${indent([this.consequence(usage)]).join('\n')}`,
      `Changed ${this.kind.noun} ${name}.`,
      true,
    );
  }

  /** `rm <name> [--remove-from-profiles]`. */
  async remove(invocation: VerbInvocation): Promise<number> {
    const { client, io } = this.deps;
    const name = this.checkedName(invocation.args[0], `${this.kind.noun} to remove`);
    const path = this.pathOf(name);
    const file = await readConfigFile(client, path);
    if (!file.exists) throw new ItemCommandError(`There is no ${this.kind.noun} ${name} on this machine.`);
    const reference = this.referenceOf(name);
    const usage = (await UsageIndex.load(client)).of(reference);
    const withProfiles = itemFlagOn(invocation, 'remove-from-profiles');
    const sentence = this.kind.noun.charAt(0).toUpperCase() + this.kind.noun.slice(1);
    if (usage.direct.length > 0 && !withProfiles) {
      const behind = usage.runtimes.length === 0 ? '' : ` (used by ${names(usage.runtimes)})`;
      throw new ItemCommandError(
        `${sentence} ${name} is a layer in ${names(usage.direct)}${behind}. Remove it from those first, or add --remove-from-profiles.`,
      );
    }
    const edits: { path: string; text: string; etag: string }[] = [];
    for (const profile of usage.direct) {
      const profilePath = `profiles/${profile}${EXTENSION}`;
      const profileFile = await readConfigFile(client, profilePath);
      const profileDocument = documentOf(profileFile.text, profilePath);
      const layers = (Array.isArray(profileDocument.contents) ? profileDocument.contents : []).filter(
        layer => layer !== reference,
      );
      if (layers.length === 0)
        throw new ItemCommandError(
          `Removing ${this.kind.noun} ${name} would leave profile ${profile} with no layers; add another layer to it first.`,
        );
      edits.push({
        path: profilePath,
        etag: profileFile.etag,
        text: editConfigText(profileFile.text, { ...profileDocument, contents: layers }, profileDocument, undefined),
      });
    }
    const what =
      usage.direct.length === 0
        ? 'Nothing uses it.'
        : `Removes it from ${names(usage.direct)}${usage.runtimes.length === 0 ? '' : `, which changes ${counted(usage.runtimes.length, 'runtime')}`}. Running sessions keep the old version until restarted.`;
    io.out(`${[`Delete ${this.kind.noun} ${name}`, ...indent([what])].join('\n')}\n`);
    if (itemFlagOn(invocation, 'dry-run')) {
      io.out('Dry run: nothing was changed.\n');
      return 0;
    }
    if (!(await this.agreed(invocation))) return 1;
    for (const edit of edits) await this.put(edit.path, edit.text, edit.etag);
    const result = await client.call<WriteResult>(DELETE, { query: { path, etag: file.etag } });
    return this.reported(result, `Removed ${this.kind.noun} ${name}.`);
  }

  /** The yes a change that edits or removes something needs: `--yes`, or the terminal's answer; never assumed. */
  private async agreed(invocation: VerbInvocation): Promise<boolean> {
    if (itemFlagOn(invocation, 'yes', 'y')) return true;
    const { io, confirm } = this.deps;
    if (confirm !== undefined && (await confirm('Go ahead? [y/N]'))) return true;
    io.err(
      confirm === undefined
        ? 'Nothing was changed: this needs a yes. Re-run with --yes to go ahead without being asked.\n'
        : 'Nothing was changed.\n',
    );
    return false;
  }

  private reported(result: WriteResult, applied: string): number {
    const { io } = this.deps;
    if (result.outcome === 'pending') {
      io.out(
        `${[
          'Saved, but waiting for the owner: the tighter version stays in effect until it is confirmed.',
          ...indent(result.pending?.changes ?? []),
        ].join('\n')}\n`,
      );
      return 0;
    }
    io.out(`${applied}\n`);
    return 0;
  }

  private async write(
    invocation: VerbInvocation,
    path: string,
    text: string,
    etag: string,
    title: string,
    applied: string,
    needsYes: boolean,
  ): Promise<number> {
    const { io } = this.deps;
    io.out(`${title}\n`);
    if (itemFlagOn(invocation, 'dry-run')) {
      io.out(`Dry run: nothing was changed. The file would read:\n${text}`);
      return 0;
    }
    if (needsYes && !(await this.agreed(invocation))) return 1;
    return this.reported(await this.put(path, text, etag), applied);
  }
}

/**
 * A verb body as the shell calls it: a refusal in plain words is printed and exits 1; a daemon refusal says its located
 * issues; anything else is the caller's.
 */
export function itemVerb(deps: Pick<ConfigItemsDeps, 'io'>, body: () => Promise<number>): Promise<number> {
  return body().catch((cause: unknown) => {
    deps.io.err(`${cause instanceof ItemCommandError ? cause.message : failureWords(cause)}\n`);
    return 1;
  });
}

/** What a kind that holds one mapping from a local file (`settings:`, `hooks:`) says about itself. */
export interface MappingItemSpec {
  readonly collection: string;
  readonly noun: string;
  readonly layer: string;
  readonly command: string;
  /** The key the mapping sits under in the document: `settings` or `hooks`. */
  readonly key: 'settings' | 'hooks';
  /** The shell's reader of a local file ('-' is stdin); absent where the shell gives none. */
  readonly readText: ((path: string) => Promise<string>) | undefined;
}

/**
 * A kind whose document is `{ description?, <key>: { … } }` and whose mapping comes from a local file (`--file <path>`,
 * JSON or YAML — JSON is YAML). A hooks file may be written with its own `hooks:` key at the top, as the harness writes
 * it, or as the bare events. An edit without `--file` keeps the mapping it has.
 */
export function mappingItemKind(spec: MappingItemSpec): ConfigItemKind {
  const mappingOf = async (path: string): Promise<Record<string, unknown>> => {
    if (spec.readText === undefined)
      throw new ItemCommandError('This terminal cannot read a file, so --file is not available here.');
    let text: string;
    try {
      text = await spec.readText(path);
    } catch {
      throw new ItemCommandError(`Could not read ${path}.`);
    }
    const read = readConfigText(text);
    if (!read.ok) throw new ItemCommandError(`${path} does not parse as JSON or YAML, so nothing was changed.`);
    const value = read.read.value;
    if (!isRecord(value)) throw new ItemCommandError(`${path} must hold a mapping of keys, so nothing was changed.`);
    return spec.key === 'hooks' && isRecord(value.hooks) ? value.hooks : value;
  };
  return {
    collection: spec.collection,
    noun: spec.noun,
    layer: spec.layer,
    command: spec.command,
    async fields(invocation, current) {
      const file = itemFlag(invocation, 'file');
      const description = itemFlag(invocation, 'description');
      const document: Record<string, unknown> = { ...(current ?? {}) };
      if (description !== undefined) document.description = description;
      if (file !== undefined) document[spec.key] = await mappingOf(file);
      else if (current === undefined)
        throw new ItemCommandError(
          `A ${spec.noun} needs its ${spec.key} from a file: add --file <path> (JSON or YAML).`,
        );
      return document;
    },
    details(document) {
      const mapping = isRecord(document[spec.key]) ? (document[spec.key] as Record<string, unknown>) : {};
      return [
        ...(typeof document.description === 'string' ? [`About: ${document.description}`] : []),
        `${spec.key === 'hooks' ? 'Events' : 'Keys'}: ${names(Object.keys(mapping))}`,
      ];
    },
  };
}
