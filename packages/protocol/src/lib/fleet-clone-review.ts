/**
 * What a Clone would make the target RUN, in words (docs/design/account-model.md §4.7, the
 * cross-machine review in docs/cross-daemon.md §3a).
 *
 * A Clone copies components from the source machine, and three kinds of them start programs on the
 * target the next time an agent launches there: an MCP server is a command line, a hooks component is
 * a document of commands or a folder of scripts, and a settings component carries launch flags, launch
 * environment and a settings file that can name helpers. If the source machine was broken into, those
 * are what it plants. A count ("3 components") is not something a person can approve, so this module
 * lists every one of them, as text, from the bundle itself.
 *
 * ONE OWNER, TWO READERS. The app's Clone preview and the target's own `describeClone` both read
 * {@link cloneRunnables}, so the screen and the change the target applies can never disagree about
 * what runs.
 *
 * NOTHING IS HIDDEN. Elsewhere a secret-looking value is cut out before it reaches a screen. Here it is
 * not: the source chose every name, so a command placed in a variable called `API_TOKEN` would be
 * hidden exactly where it needs to be read. The bundle never carries a login, and a secret travels as a
 * `${secret:NAME}` reference, so what is shown is what the source exported and nothing more.
 *
 * Pure and defensive: the bundle is the source machine's data, checked only as far as its schema goes,
 * so every field is read as `unknown`. A component that names nothing the bundle carries is not listed:
 * it can only point at what the target already has.
 */
import type { FleetCloneBundle } from './fleet-setup.ts';

/** The component kinds whose content can start a program on the target. */
export const CLONE_RUNNABLE_KINDS = ['mcp', 'hooks', 'settings'] as const;
export type CloneRunnableKind = (typeof CLONE_RUNNABLE_KINDS)[number];

/** One thing a component would run or change, in words. */
export interface CloneRunnableEntry {
  /** What it is: "Starts", "Environment NODE_OPTIONS", "Setting statusLine.command", "Script hooks/a/run.sh". */
  readonly label: string;
  /** Exactly what the source exported: the command line, the value, or a whole document. */
  readonly text: string;
  /** A whole document rather than one line, so a reader shows it as a block. */
  readonly document: boolean;
}

/** One component that runs something on the target, and everything it runs. */
export interface CloneRunnable {
  /** `<kind>/<name>`, as a profile layer and the `skip` list name it. */
  readonly reference: string;
  readonly kind: CloneRunnableKind;
  readonly name: string;
  readonly harness?: 'claude' | 'codex';
  readonly entries: readonly CloneRunnableEntry[];
}

/**
 * The settings keys that start a program, change what an agent may do without asking, or send its
 * traffic somewhere else. Matched against every word of a settings document's dotted key, so
 * `statusLine.command`, `hooks.PreToolUse.0.hooks.0.command`, `mcp_servers.x.args`, `apiKeyHelper` and
 * `model_providers.x.base_url` are all called out by name. The whole document is listed as well, so a
 * key this list does not know is still on screen.
 */
const RUNNABLE_SETTING_WORD =
  /^(?:command|commands|args|env|hooks?|.*helper|notify|mcp.*|permissions?|allow|default_?mode|sandbox.*|approval.*|.*base_?url|.*providers?|.*refresh|.*export|shell.*)$/iu;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** A command line as a person would type it: each argument with whitespace or quotes in it is quoted. */
export const commandLine = (command: string, args: readonly unknown[] = []): string =>
  [command, ...args.map(asText)]
    .map(part => (part === '' || /[\s"'\\$`]/u.test(part) ? JSON.stringify(part) : part))
    .join(' ');

/** Every `NAME=value` the component sets, in name order. */
const envEntries = (env: unknown): CloneRunnableEntry[] =>
  isRecord(env)
    ? Object.keys(env)
        .toSorted()
        .map(name => ({ label: `Environment ${name}`, text: asText(env[name]), document: false }))
    : [];

/** Every leaf of a JSON document as its key path and value, or `null` when it is not JSON. */
const jsonLeaves = (text: string): (readonly [readonly string[], unknown])[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const leaves: (readonly [readonly string[], unknown])[] = [];
  const walk = (path: readonly string[], value: unknown): void => {
    if (!isRecord(value) && !Array.isArray(value)) {
      leaves.push([path, value]);
      return;
    }
    const children: [string, unknown][] = Array.isArray(value)
      ? value.map((child, index) => [String(index), child])
      : Object.entries(value);
    for (const [key, child] of children) walk([...path, key], child);
  };
  walk([], parsed);
  return leaves;
};

/** A settings document's runnable keys (TOML, or JSON a harness would refuse, lists none: its text is still shown). */
const runnableSettings = (text: string): CloneRunnableEntry[] =>
  (jsonLeaves(text) ?? [])
    .filter(([path]) => path.some(key => RUNNABLE_SETTING_WORD.test(key)))
    .map(([path, value]) => ({ label: `Setting ${path.join('.')}`, text: asText(value), document: false }));

/** A hooks document's commands: every `command` it holds, under the event it runs on. */
const hookCommands = (text: string): CloneRunnableEntry[] =>
  (jsonLeaves(text) ?? [])
    .filter(([path]) => path.at(-1) === 'command')
    .map(([path, value]) => ({
      label: `Runs on ${path.slice(0, -1).join('.')}`,
      text: asText(value),
      document: false,
    }));

const documentEntry = (label: string, path: string, content: string): CloneRunnableEntry => ({
  label: `${label} ${path}`,
  text: content,
  document: true,
});

/** Whether a carried file sits inside a folder the component names. */
const inside = (directory: string, path: string): boolean =>
  path.startsWith(directory.endsWith('/') ? directory : `${directory}/`);

/**
 * Every MCP server, hooks component and settings component in the bundle, with each command, flag,
 * variable, runnable setting and document it brings. In the order the bundle lists them by kind, then by
 * name, so two readers list them identically.
 */
export function cloneRunnables(bundle: FleetCloneBundle): readonly CloneRunnable[] {
  const files = new Map(bundle.files.map(file => [file.path, file.content]));
  const runnables: CloneRunnable[] = [];
  for (const kind of CLONE_RUNNABLE_KINDS) {
    const components = bundle.components[kind] ?? {};
    for (const name of Object.keys(components).toSorted()) {
      const component = isRecord(components[name]) ? components[name] : {};
      const entries: CloneRunnableEntry[] = [];
      if (kind === 'mcp') {
        if (component.command !== undefined) {
          const args = Array.isArray(component.args) ? component.args : [];
          entries.push({ label: 'Starts', text: commandLine(asText(component.command), args), document: false });
        }
        if (component.url !== undefined)
          entries.push({ label: 'Reaches', text: asText(component.url), document: false });
        entries.push(...envEntries(component.env));
      }
      if (kind === 'settings') {
        if (Array.isArray(component.flags)) {
          entries.push(...component.flags.map(flag => ({ label: 'Launch flag', text: asText(flag), document: false })));
        }
        entries.push(...envEntries(component.env));
      }
      if (kind !== 'mcp' && typeof component.file === 'string') {
        const content = files.get(component.file);
        if (content !== undefined) {
          if (kind === 'settings') entries.push(...runnableSettings(content));
          if (kind === 'hooks') entries.push(...hookCommands(content));
          entries.push(documentEntry(kind === 'hooks' ? 'Hooks file' : 'Settings file', component.file, content));
        }
      }
      if (typeof component.directory === 'string') {
        const directory = component.directory;
        for (const file of bundle.files
          .filter(candidate => inside(directory, candidate.path))
          .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
          entries.push(documentEntry('Script', file.path, file.content));
        }
      }
      // A component naming only a file outside the bundle runs the TARGET's own file, which the source
      // never touched, so it plants nothing to review.
      if (entries.length === 0) continue;
      const harness = component.harness === 'claude' || component.harness === 'codex' ? component.harness : undefined;
      runnables.push({
        reference: `${kind}/${name}`,
        kind,
        name,
        ...(harness === undefined ? {} : { harness }),
        entries,
      });
    }
  }
  return runnables;
}
