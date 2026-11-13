/**
 * `fy config …` (docs/config-files.md): check and find this machine's configuration files. Kernel-owned, so the shell's
 * own verbs, like `fy daemon`.
 *
 * `path`, `check`, `schema` and `guide` need no daemon: an agent can find the files, learn their shape and check its own
 * edit on a machine whose daemon is stopped (the compiled manifests declare the files, and the Kernel's own checker
 * reads them). `status`, `show`, `write` and `confirm` ask the daemon, because what is IN EFFECT, and the owner's
 * confirmation of an edit that loosens, are the daemon's. Nothing here prints a secret value: a file names secrets as
 * `${secret:NAME}` and a raw one is refused, so what a read shows is already masked by the daemon.
 */
import { config } from '@ferretry/kernel/host';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { optionOn, optionText } from '../argv.ts';
import { checkConfigDirectory } from '../config/check.ts';
import { claimSpelling, declaredConfig, kindOf } from '../config/declared.ts';
import { setUpFerretrySkill } from '../config/guide.ts';
import type { ConfigFilesPort } from '../config/ports.ts';
import { renderConfigReport, renderIssue, renderPending } from '../config/render.ts';
import {
  ConfirmResultSchema,
  FileViewSchema,
  InvalidBodySchema,
  PutResultSchema,
  StatusViewSchema,
} from '../config/wire.ts';
import { DaemonRefusal, EXIT, ShellError } from '../errors.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';

/** What one verb accepts, so a stray word or option is refused the way the old parser refused it. */
interface Shape {
  readonly command: string;
  /** Required positionals, then optional ones. */
  readonly required: readonly string[];
  readonly optional?: readonly string[];
  /** Switches (`--json`): never take a value. */
  readonly switches?: readonly string[];
  /** Options that take a value (`--if-match <etag>`). */
  readonly valued?: readonly string[];
}

/** A verb's words as the shell split them, with a switch's swallowed word handed back to the positionals. */
interface Words {
  readonly args: readonly string[];
  readonly invocation: VerbInvocation;
}

const spelled = (name: string): string => `${name.length === 1 ? '-' : '--'}${name}`;

/**
 * The shell cannot know which option takes a value, so `--json file` reads `file` as the value of `--json`. A switch a
 * verb declares never takes one: the word goes back to the positionals, in the order it was typed after the rest.
 */
function readWords(ctx: ShellContext, shape: Shape): Words {
  const { invocation } = ctx;
  const switches = shape.switches ?? [];
  const valued = shape.valued ?? [];
  const args = [...invocation.args];
  const options: Record<string, string | boolean | readonly string[]> = {};
  for (const [name, value] of Object.entries(invocation.options)) {
    if (!switches.includes(name) && !valued.includes(name))
      throw new ShellError(`error: unknown option '${spelled(name)}'`);
    if (switches.includes(name) && typeof value === 'string') {
      args.push(value);
      options[name] = true;
    } else if (valued.includes(name) && typeof value === 'boolean')
      throw new ShellError(`error: option '${spelled(name)} <${name}>' argument missing`);
    else options[name] = value;
  }
  const missing = shape.required[args.length];
  if (missing !== undefined) throw new ShellError(`error: missing required argument '${missing}'`);
  const most = shape.required.length + (shape.optional?.length ?? 0);
  if (args.length > most)
    throw new ShellError(
      `error: too many arguments for '${shape.command}'. Expected ${String(most)} argument${most === 1 ? '' : 's'} but got ${String(args.length)}.`,
    );
  return { args, invocation: { args, options } };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function filesOf(ctx: ShellContext): ConfigFilesPort {
  const files = ctx.world.config;
  if (files === undefined) throw new ShellError('this fy cannot read the configuration directory');
  return files;
}

const KERNEL = 'kernel';

/** `fy config path [file]`: the configuration directory, or one file in it. */
export const configPath: ShellVerb = async ctx => {
  const { args } = readWords(ctx, { command: 'path', required: [], optional: ['file'] });
  const directory = filesOf(ctx).directory;
  const [file] = args;
  if (file === undefined) {
    ctx.world.io.out(`${directory}\n`);
    return EXIT.ok;
  }
  const declarations = declaredConfig(ctx.world.registry);
  if (config.targetOfPath(declarations, file) === undefined)
    throw new ShellError(
      `${file} is not a Ferretry configuration file — name one a plugin declares under config/: ${declarations.map(claimSpelling).sort().join(', ')}`,
    );
  ctx.world.io.out(`${directory}/${file}\n`);
  return EXIT.ok;
};

/** `fy config check` (the default of `fy config`): every file, as the daemon would; exits non-zero on an error. */
export const configCheck: ShellVerb = async ctx => {
  const { invocation } = readWords(ctx, { command: 'check', required: [], switches: ['json'] });
  const files = filesOf(ctx);
  const { binary } = ctx.world.identity;
  const report = checkConfigDirectory({
    declarations: declaredConfig(ctx.world.registry),
    files: await files.list(),
    accepted: await files.accepted(),
    digest: text => files.digest(text),
    binary,
  });
  ctx.world.io.out(optionOn(invocation, 'json') ? json(report) : `${renderConfigReport(report, binary)}\n`);
  return report.issues.some(issue => issue.severity === 'error') ? EXIT.failure : EXIT.ok;
};

/**
 * The kind names v4 accepted (`protocol/config-files.ts` CONFIG_SCHEMA_IDS) for a file 5.0 still reads, each answered by
 * the stem of the declaration that continues it, so a script written against the old help keeps working. Only a name whose
 * successor is a declared file is here: `machine`, `component-settings` and `component-hooks` (now one per harness),
 * `modelsGuide` and `preset` have no single 5.0 file, and a schema is never invented for them. `warden`, `voice` and
 * `limits` kept their names and need no alias. An alias is never LISTED; the stems are the canonical names.
 */
const V4_KIND_NAMES: ReadonlyMap<string, string> = new Map([
  ['login', 'logins--item'],
  ['profile', 'profiles--item'],
  ['runtime', 'runtimes--item'],
  ['models', 'models--item'],
  ['component-instructions', 'instructions--item'],
  ['component-mcp', 'mcp--item'],
  ['component-skills', 'skills--item'],
  ['component-modelSets', 'model-sets--item'],
  ['learning', 'lessons'],
  ['pack', 'packs'],
  ['accountDefaults', 'accounts'],
]);

/** `fy config schema [kind]`: the JSON Schema of one kind of file, or the list of kinds. */
export const configSchema: ShellVerb = async ctx => {
  const { args } = readWords(ctx, { command: 'schema', required: [], optional: ['kind'] });
  const declarations = declaredConfig(ctx.world.registry);
  const kinds = declarations.map(kindOf).sort();
  const [kind] = args;
  if (kind === undefined) {
    ctx.world.io.out(kinds.length === 0 ? '' : `${kinds.join('\n')}\n`);
    return EXIT.ok;
  }
  const wanted = kind.replace(/\.json$/u, '');
  const stem = V4_KIND_NAMES.get(wanted);
  const found =
    declarations.find(each => kindOf(each) === wanted) ??
    (stem === undefined ? undefined : declarations.find(each => kindOf(each) === stem));
  if (found === undefined) throw new ShellError(`no kind ${kind} — one of ${kinds.join(', ')}`);
  ctx.world.io.out(config.configJsonSchemaText(found.def));
  return EXIT.ok;
};

/** `fy config guide`: the built-in "Set up Ferretry" skill, as a SKILL.md. */
export const configGuide: ShellVerb = async ctx => {
  readWords(ctx, { command: 'guide', required: [] });
  ctx.world.io.out(setUpFerretrySkill(ctx.world.identity.binary, declaredConfig(ctx.world.registry)));
  return EXIT.ok;
};

/** `fy config status`: what the daemon has in effect, every problem, every change waiting. */
export const configStatus: ShellVerb = async ctx => {
  const { invocation } = readWords(ctx, { command: 'status', required: [], switches: ['json'] });
  const status = StatusViewSchema.parse(await ctx.client(KERNEL).call('GET /v1/config/status'));
  const { binary } = ctx.world.identity;
  ctx.world.io.out(
    optionOn(invocation, 'json')
      ? json(status)
      : `${status.directory}\n${renderConfigReport({ files: status.files.length, issues: status.issues, pending: status.pending }, binary)}\n`,
  );
  return EXIT.ok;
};

/** `fy config show <file>`: one file as the daemon holds it: where it stands, its etag, its issues and its text. */
export const configShow: ShellVerb = async ctx => {
  const { args, invocation } = readWords(ctx, { command: 'show', required: ['file'], switches: ['json'] });
  const view = FileViewSchema.parse(
    await ctx.client(KERNEL).call('GET /v1/config/file', { query: { path: args[0] as string } }),
  );
  if (optionOn(invocation, 'json')) {
    ctx.world.io.out(json(view));
    return EXIT.ok;
  }
  const state = view.exists ? view.state : 'does not exist yet — this is the starter a new one begins with';
  ctx.world.io.out(
    `${[`${view.absolutePath} (${state})`, `etag: ${view.etag}`, ...view.issues.map(renderIssue), '', view.text].join('\n')}\n`,
  );
  return EXIT.ok;
};

/**
 * `fy config write <file>`: the file's whole new text from standard input, through the daemon. Refused whole unless it
 * checks (the located issues are printed, then the sentence), and refused if the file moved since `--if-match`. At this
 * machine a loosening is in effect at once.
 */
export const configWrite: ShellVerb = async ctx => {
  const { args, invocation } = readWords(ctx, { command: 'write', required: ['file'], valued: ['if-match'] });
  const file = args[0] as string;
  const ifMatch = optionText(invocation, 'if-match');
  // Whole and unaltered: YAML whitespace is meaning.
  const text = await ctx.world.host.readText('-');
  let written: ReturnType<typeof PutResultSchema.parse>;
  try {
    written = PutResultSchema.parse(
      await ctx.client(KERNEL).call('PUT /v1/config/file', {
        body: { path: file, text, ...(ifMatch === undefined ? {} : { etag: ifMatch }) },
      }),
    );
  } catch (error) {
    const invalid = error instanceof DaemonRefusal ? InvalidBodySchema.safeParse(error.body) : undefined;
    if (invalid?.success !== true) throw error;
    ctx.world.io.out(`${invalid.data.issues.map(renderIssue).join('\n')}\n`);
    throw new ShellError(invalid.data.error);
  }
  const { binary } = ctx.world.identity;
  ctx.world.io.out(
    written.outcome === 'applied'
      ? `Wrote ${file}; it is in effect (etag ${written.etag}).\n`
      : `Wrote ${file}; it waits for your confirmation: ${(written.pending?.changes ?? []).join('; ')}.\n  confirm: ${binary} config confirm ${file}\n`,
  );
  return EXIT.ok;
};

/**
 * `fy config confirm [file]`: puts into effect the edit to `file` that is waiting, as the daemon holds it now. Without a
 * file, lists what waits. The daemon answers only at this machine; a remote device confirms in the app with a passkey.
 */
export const configConfirm: ShellVerb = async ctx => {
  const { args } = readWords(ctx, { command: 'confirm', required: [], optional: ['file'] });
  const { binary } = ctx.world.identity;
  const { pending } = StatusViewSchema.parse(await ctx.client(KERNEL).call('GET /v1/config/status'));
  const [file] = args;
  if (file === undefined) {
    ctx.world.io.out(
      `${pending.length === 0 ? 'Nothing is waiting for your confirmation.' : pending.map(item => renderPending(item, binary)).join('\n')}\n`,
    );
    return EXIT.ok;
  }
  const held = pending.find(item => item.path === file);
  if (held === undefined) throw new ShellError(`${file} has no change waiting for your confirmation`);
  const result = ConfirmResultSchema.parse(
    await ctx.client(KERNEL).call('POST /v1/config/confirm', { body: { path: held.path, etag: held.etag } }),
  );
  if (!result.confirmed)
    throw new ShellError(`${file} changed again before it could be confirmed; run ${binary} config confirm again`);
  ctx.world.io.out(`Confirmed ${file}: ${held.changes.join('; ')}. It is in effect now.\n`);
  return EXIT.ok;
};
