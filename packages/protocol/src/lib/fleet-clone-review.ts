/**
 * What a Clone would make the target RUN, in words (docs/design/account-model.md §4.7, the
 * cross-machine review in docs/cross-daemon.md §3a).
 *
 * A Clone copies components from the source machine, and every kind but a model set can make the
 * target run something: an MCP server is a command line, a hooks component is a document of commands
 * or a folder of scripts, a settings component carries launch flags, launch environment and a settings
 * file that can name helpers — and instructions and skills are text an agent FOLLOWS, which an agent
 * running unattended will act on, scripts included. If the source machine was broken into, those are
 * what it plants. A count ("3 components") is not something a person can approve, so this module lists
 * every one of them, as text, from the bundle itself.
 *
 * EVERY CARRIED FILE IS SHOWN, OR THE BUNDLE IS REFUSED. The review and the write must agree on which
 * file belongs to which component, so both read {@link cloneFileOwned}, and {@link cloneBundleProblem}
 * refuses a bundle a byte-for-byte match could misread: a path spelled two ways (`./x`, `a//b`, `a/./b`,
 * a trailing `/`) that the provisioner would normalise into one, the same path twice, or a file no
 * carried component owns — which would otherwise overwrite one of the TARGET's own documents while the
 * review listed nothing.
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
 * Pure, total and defensive: the bundle is the source machine's data, checked only as far as its schema
 * goes, so every field is read as `unknown`, and a document too deep or too large to walk key by key is
 * shown whole instead (a recursive walk was a stack overflow at depth 20,000). A component that names
 * nothing the bundle carries is not listed: it can only point at what the target already has.
 */
import type { FleetCloneBundle } from './fleet-setup.ts';

/** The component kinds whose content can make the target run something: every kind but a model set. */
export const CLONE_RUNNABLE_KINDS = ['instructions', 'mcp', 'skills', 'settings', 'hooks'] as const;

/** Where a skills component's items travel: `skills/<item>/…` (the fleet's skills store). */
export const CLONE_SKILLS_DIRECTORY = 'skills';
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

/** Past either, a document is shown whole rather than key by key. */
export const CLONE_REVIEW_MAX_DEPTH = 64;
export const CLONE_REVIEW_MAX_LEAVES = 2_000;

interface JsonLeaves {
  readonly leaves: readonly (readonly [readonly string[], unknown])[];
  /** The walk stopped at a cap, so the leaves are not all of them. */
  readonly truncated: boolean;
}

/** Every leaf of a JSON document as its key path and value, or `null` when it is not JSON. Iterative and capped. */
const jsonLeaves = (text: string): JsonLeaves | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const leaves: (readonly [readonly string[], unknown])[] = [];
  const stack: (readonly [readonly string[], unknown])[] = [[[], parsed]];
  let truncated = false;
  while (stack.length > 0) {
    const [path, value] = stack.pop() as readonly [readonly string[], unknown];
    if (!isRecord(value) && !Array.isArray(value)) {
      if (leaves.length >= CLONE_REVIEW_MAX_LEAVES) {
        truncated = true;
        break;
      }
      leaves.push([path, value]);
      continue;
    }
    if (path.length >= CLONE_REVIEW_MAX_DEPTH) {
      truncated = true;
      continue;
    }
    const children: [string, unknown][] = Array.isArray(value)
      ? value.map((child, index) => [String(index), child])
      : Object.entries(value);
    // Reversed onto the stack, so leaves come out in document order.
    for (const [key, child] of children.toReversed()) stack.push([[...path, key], child]);
  }
  return { leaves, truncated };
};

/** What is said when a document could not be walked to the end. */
const TRUNCATED_ENTRY: CloneRunnableEntry = {
  label: 'Too deep or too large to list key by key',
  text: 'Read the whole document below.',
  document: false,
};

/** A settings document's runnable keys (TOML, or JSON a harness would refuse, lists none: its text is still shown). */
const runnableSettings = (text: string): CloneRunnableEntry[] => {
  const walked = jsonLeaves(text);
  if (walked === null) return [];
  const entries = walked.leaves
    .filter(([path]) => path.some(key => RUNNABLE_SETTING_WORD.test(key)))
    .map(([path, value]) => ({ label: `Setting ${path.join('.')}`, text: asText(value), document: false }));
  return walked.truncated ? [...entries, TRUNCATED_ENTRY] : entries;
};

/** A hooks document's commands: every `command` it holds, under the event it runs on. */
const hookCommands = (text: string): CloneRunnableEntry[] => {
  const walked = jsonLeaves(text);
  if (walked === null) return [];
  const entries = walked.leaves
    .filter(([path]) => path.at(-1) === 'command')
    .map(([path, value]) => ({
      label: `Runs on ${path.slice(0, -1).join('.')}`,
      text: asText(value),
      document: false,
    }));
  return walked.truncated ? [...entries, TRUNCATED_ENTRY] : entries;
};

const DOCUMENT_LABELS: Readonly<Record<CloneRunnableKind, string>> = {
  instructions: 'Instructions file',
  mcp: 'File',
  skills: 'Skill file',
  settings: 'Settings file',
  hooks: 'Hooks file',
};

const documentEntry = (label: string, path: string, content: string): CloneRunnableEntry => ({
  label: `${label} ${path}`,
  text: content,
  document: true,
});

/** Whether a carried file sits inside a folder. */
const inside = (directory: string, path: string): boolean => path.startsWith(`${directory}/`);

const byPath = (left: { readonly path: string }, right: { readonly path: string }): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/** The skill items a skills component selects, as the bundle spelled them. */
const skillItems = (component: Readonly<Record<string, unknown>>): string[] =>
  Array.isArray(component.items) ? component.items.filter((item): item is string => typeof item === 'string') : [];

/**
 * Whether a carried file belongs to this component: its `file`, a file under its `directory`, or — for
 * skills — a file under one of its items. The ONE membership rule: the review lists by it, and the
 * target writes, skips and refuses by it.
 */
export const cloneFileOwned = (component: unknown, path: string): boolean => {
  if (!isRecord(component)) return false;
  if (component.file === path) return true;
  if (typeof component.directory === 'string' && inside(component.directory, path)) return true;
  return skillItems(component).some(item => inside(`${CLONE_SKILLS_DIRECTORY}/${item}`, path));
};

/** A path inside the setup folder written exactly one way: no `.`/`..`/empty segment, no leading `/`, `~`, `$`, no `\`. */
export const isCanonicalAssetPath = (path: string): boolean =>
  path !== '' &&
  !path.startsWith('~') &&
  !path.startsWith('$') &&
  !path.includes('\\') &&
  path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');

/** A reference to something outside the setup folder: it travels as a name, never as a carried file. */
const isOutsideReference = (path: string): boolean =>
  path.startsWith('/') || path.startsWith('~') || path.startsWith('$');

/**
 * Why the target must refuse this bundle, in one sentence, or `null` when every carried file is owned by
 * exactly the component the review lists it under. The review and the write cannot disagree about a
 * bundle this accepts.
 */
export function cloneBundleProblem(bundle: FleetCloneBundle): string | null {
  const from = `The setup from ${bundle.machine}`;
  const seen = new Set<string>();
  for (const file of bundle.files) {
    if (!isCanonicalAssetPath(file.path)) {
      return `${from} carries a file at ${file.path}, which is not a plain path inside its own setup folder, so none of it can be copied.`;
    }
    if (seen.has(file.path)) return `${from} carries ${file.path} twice, so none of it can be copied.`;
    seen.add(file.path);
  }
  const components = Object.entries(bundle.components).flatMap(([kind, entries]) =>
    Object.entries(entries).map(([name, component]) => ({ reference: `${kind}/${name}`, component })),
  );
  for (const { reference, component } of components) {
    if (!isRecord(component)) continue;
    for (const field of ['file', 'directory'] as const) {
      const value = component[field];
      if (typeof value !== 'string' || isOutsideReference(value) || isCanonicalAssetPath(value)) continue;
      return `${from} names ${value} for ${reference}, which is not written one plain way, so none of it can be copied.`;
    }
  }
  const orphan = bundle.files.find(file => !components.some(({ component }) => cloneFileOwned(component, file.path)));
  if (orphan !== undefined) {
    return `${from} carries ${orphan.path}, which none of its components uses, so none of it can be copied.`;
  }
  return null;
}

/**
 * Every component that can make the target run something, with each command, flag, variable, runnable
 * setting and document it brings — every carried file it owns, in full. In a fixed kind order, then by
 * name, so two readers list them identically. Read it only for a bundle {@link cloneBundleProblem} accepts.
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
          entries.push(documentEntry(DOCUMENT_LABELS[kind], component.file, content));
        }
      }
      // Every other file it owns: a hooks folder's scripts, a skill item's files.
      for (const file of bundle.files
        .filter(candidate => candidate.path !== component.file && cloneFileOwned(component, candidate.path))
        .toSorted(byPath)) {
        entries.push(documentEntry(kind === 'skills' ? 'Skill file' : 'Script', file.path, file.content));
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
