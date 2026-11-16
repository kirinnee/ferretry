/**
 * `fy config check|path|schema|status|show|write|confirm|guide` (docs/config-files.md; parity rows V-0189 … V-0197).
 *
 * Every verb is composed over the kernel's own configuration routes, through the guarded client: what is in effect and
 * what is wrong (`GET /v1/config/status`), one file and the etag to edit it against (`GET /v1/config/file`), a checked
 * edit (`PUT /v1/config/file`, refused whole with the located problems unless it checks) and the owner's confirmation
 * of a held edit (`POST /v1/config/confirm`, named by the etag that was reviewed). The CLI holds no rule of its own:
 * validation, the hold on a loosening and the refusal of a raw secret are the daemon's, so this can only ever say what
 * the daemon said. `guide` and `path` of the directory are the shell's alone.
 *
 * GAP: v4 checked and read schemas WITHOUT a daemon. Here the daemon owns the checker, so `check` asks it (any `fy`
 * command starts one); `schema` reads the file the daemon publishes under `config/.schema/`.
 */
import { z } from 'zod';
import { DaemonRefusal, EXIT } from '../errors.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';
import { setUpFerretrySkill } from './config-guide.ts';

const NonEmpty = z.string().min(1);

const IssueSchema = z.looseObject({
  path: NonEmpty,
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  severity: z.enum(['error', 'warning']),
  message: NonEmpty,
  fix: z.string().optional(),
});
type Issue = z.infer<typeof IssueSchema>;

const PendingSchema = z.looseObject({ path: NonEmpty, etag: NonEmpty, changes: z.array(NonEmpty).min(1) });
type Pending = z.infer<typeof PendingSchema>;

const StatusSchema = z.looseObject({
  directory: NonEmpty,
  files: z.array(z.looseObject({ path: NonEmpty, kind: NonEmpty, schema: z.string().optional(), state: z.string() })),
  issues: z.array(IssueSchema),
  pending: z.array(PendingSchema),
});
type Status = z.infer<typeof StatusSchema>;

const FileSchema = z.looseObject({
  path: NonEmpty,
  absolutePath: z.string().optional(),
  exists: z.boolean(),
  text: z.string(),
  etag: NonEmpty,
  state: z.string().optional(),
  issues: z.array(IssueSchema).optional(),
});

const PutSchema = z.looseObject({
  path: NonEmpty,
  etag: NonEmpty,
  outcome: z.enum(['applied', 'pending']),
  pending: PendingSchema.optional(),
});

const ConfirmSchema = z.looseObject({ path: NonEmpty, confirmed: z.boolean() });

const InvalidBodySchema = z.looseObject({ error: NonEmpty, issues: z.array(IssueSchema) });

const SCHEMA_FOLDER = '.schema';

const on = (ctx: ShellContext, name: string): boolean => {
  const value = ctx.invocation.options[name];
  return value === true || value === 'true';
};

const text = (ctx: ShellContext, name: string): string | undefined => {
  const value = ctx.invocation.options[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[value.length - 1] as string | undefined) : undefined;
};

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** One issue as a line a person (or an agent) can jump to: `path:line:col severity: message`, then the fix. */
function renderIssue(issue: Issue): string {
  const where =
    issue.line === undefined ? issue.path : `${issue.path}:${String(issue.line)}:${String(issue.column ?? 1)}`;
  return `${where} ${issue.severity}: ${issue.message}${issue.fix === undefined ? '' : `\n  fix: ${issue.fix}`}`;
}

/** One held edit, and the command that confirms it. */
function renderPending(pending: Pending, bin: string): string {
  return `${pending.path} waits for your confirmation: ${pending.changes.join('; ')}\n  confirm: ${bin} config confirm ${pending.path}`;
}

/** The whole report: every issue, every held edit, and one summary line. */
function renderConfigReport(
  report: { readonly files: number; readonly issues: readonly Issue[]; readonly pending: readonly Pending[] },
  bin: string,
): string {
  const errors = report.issues.filter(issue => issue.severity === 'error').length;
  const warnings = report.issues.length - errors;
  return [
    ...report.issues.map(renderIssue),
    ...report.pending.map(pending => renderPending(pending, bin)),
    `${plural(report.files, 'file')} checked: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}, ${String(report.pending.length)} waiting for confirmation.`,
  ].join('\n');
}

const KERNEL = 'kernel' as const;

const readStatus = async (ctx: ShellContext): Promise<Status> =>
  StatusSchema.parse(await ctx.client(KERNEL).call('GET /v1/config/status'));

const readFile = async (ctx: ShellContext, path: string): Promise<z.infer<typeof FileSchema>> =>
  FileSchema.parse(await ctx.client(KERNEL).call('GET /v1/config/file', { query: { path } }));

const binary = (ctx: ShellContext): string => ctx.world.identity.binary;

const needs = (ctx: ShellContext, what: string, example: string): undefined => {
  ctx.world.io.err(`name ${what}: \`${binary(ctx)} config ${example}\`\n`);
  return undefined;
};

/** `fy config check`: every file as the daemon holds it; exits non-zero on an error. */
export const configCheckVerb: ShellVerb = async ctx => {
  const status = await readStatus(ctx);
  const report = { files: status.files.length, issues: status.issues, pending: status.pending };
  ctx.world.io.out(`${on(ctx, 'json') ? JSON.stringify(report, null, 2) : renderConfigReport(report, binary(ctx))}\n`);
  return status.issues.some(issue => issue.severity === 'error') ? EXIT.failure : EXIT.ok;
};

/** `fy config status`: what the daemon has in effect. */
export const configStatusVerb: ShellVerb = async ctx => {
  const status = await readStatus(ctx);
  ctx.world.io.out(
    `${
      on(ctx, 'json')
        ? JSON.stringify(status, null, 2)
        : `${status.directory}\n${renderConfigReport({ files: status.files.length, issues: status.issues, pending: status.pending }, binary(ctx))}`
    }\n`,
  );
  return EXIT.ok;
};

/** A file path as a person types it: relative, inside the directory, never a way out of it. */
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+$/u;

/** `fy config path [file]`: the directory, or one file in it. */
export const configPathVerb: ShellVerb = async ctx => {
  const { directory } = await readStatus(ctx);
  const file = ctx.invocation.args[0];
  if (file === undefined) {
    ctx.world.io.out(`${directory}\n`);
    return EXIT.ok;
  }
  if (!SAFE_RELATIVE.test(file) || !file.endsWith('.yaml')) {
    ctx.world.io.err(
      `${file} is not a Ferretry configuration file: name one relative to the directory, such as machine.yaml or logins/<id>.yaml (\`${binary(ctx)} config status\` lists them)\n`,
    );
    return EXIT.failure;
  }
  ctx.world.io.out(`${directory}/${file}\n`);
  return EXIT.ok;
};

/** The schema's file stem a person named: `runtimes--item`, `runtimes--item.json`, or a file the daemon holds. */
const schemaFileOf = (status: Status, named: string): string | undefined => {
  const byFile = status.files.find(file => file.path === named && file.schema !== undefined);
  if (byFile?.schema !== undefined) return byFile.schema;
  const wanted = named.endsWith('.json') ? named : `${named}.json`;
  return status.files.find(file => file.schema === wanted)?.schema;
};

/** `fy config schema [name|file]`: the JSON Schema of one kind of file, or the list of schemas. */
export const configSchemaVerb: ShellVerb = async ctx => {
  const status = await readStatus(ctx);
  const named = ctx.invocation.args[0];
  if (named === undefined) {
    const seen = new Map<string, string>();
    for (const file of status.files)
      if (file.schema !== undefined && !seen.has(file.schema)) seen.set(file.schema, file.kind);
    ctx.world.io.out(
      seen.size === 0
        ? 'no configuration file is in effect yet, so no schema is published\n'
        : `${[...seen].map(([schema, kind]) => `${schema.replace(/\.json$/u, '')}  (${kind})`).join('\n')}\n`,
    );
    return EXIT.ok;
  }
  const schema = schemaFileOf(status, named);
  if (schema === undefined) {
    ctx.world.io.err(`no schema ${named}: run \`${binary(ctx)} config schema\` for the list\n`);
    return EXIT.failure;
  }
  try {
    const body = await ctx.world.host.readText(`${status.directory}/${SCHEMA_FOLDER}/${schema}`);
    ctx.world.io.out(body.endsWith('\n') ? body : `${body}\n`);
    return EXIT.ok;
  } catch {
    ctx.world.io.err(`the daemon has not published ${schema} under ${status.directory}/${SCHEMA_FOLDER} yet\n`);
    return EXIT.failure;
  }
};

/** `fy config show <file>`: one file as the daemon holds it, with its etag. */
export const configShowVerb: ShellVerb = async ctx => {
  const file = ctx.invocation.args[0];
  if (file === undefined) {
    needs(ctx, 'the file', 'show <file>');
    return EXIT.usage;
  }
  const view = await readFile(ctx, file);
  if (on(ctx, 'json')) {
    ctx.world.io.out(`${JSON.stringify(view, null, 2)}\n`);
    return EXIT.ok;
  }
  const state = view.exists ? (view.state ?? 'ok') : 'does not exist yet — this is the starter a new one begins with';
  ctx.world.io.out(
    `${[`${view.absolutePath ?? view.path} (${state})`, `etag: ${view.etag}`, ...(view.issues ?? []).map(renderIssue), '', view.text].join('\n')}\n`,
  );
  return EXIT.ok;
};

/** `fy config write <file> [--if-match <etag>]`: the text from stdin, through the daemon; refused whole unless it checks. */
export const configWriteVerb: ShellVerb = async ctx => {
  const file = ctx.invocation.args[0];
  if (file === undefined) {
    needs(ctx, 'the file', 'write <file> < text.yaml');
    return EXIT.usage;
  }
  const ifMatch = text(ctx, 'if-match');
  const body = await ctx.world.host.readText('-');
  try {
    const written = PutSchema.parse(
      await ctx.client(KERNEL).call('PUT /v1/config/file', {
        body: { path: file, text: body, ...(ifMatch === undefined ? {} : { etag: ifMatch }) },
      }),
    );
    ctx.world.io.out(
      `${
        written.outcome === 'applied'
          ? `Wrote ${file}; it is in effect (etag ${written.etag}).`
          : `Wrote ${file}; it waits for your confirmation: ${(written.pending?.changes ?? []).join('; ')}.\n  confirm: ${binary(ctx)} config confirm ${file}`
      }\n`,
    );
    return EXIT.ok;
  } catch (error) {
    const invalid = error instanceof DaemonRefusal ? InvalidBodySchema.safeParse(error.body) : undefined;
    if (invalid?.success !== true) throw error;
    ctx.world.io.err(`${[...invalid.data.issues.map(renderIssue), invalid.data.error].join('\n')}\n`);
    return EXIT.failure;
  }
};

/** `fy config confirm [file]`: put into effect the edit waiting for the owner, or list what waits. */
export const configConfirmVerb: ShellVerb = async ctx => {
  const { pending } = await readStatus(ctx);
  const file = ctx.invocation.args[0];
  if (file === undefined) {
    ctx.world.io.out(
      `${pending.length === 0 ? 'Nothing is waiting for your confirmation.' : pending.map(item => renderPending(item, binary(ctx))).join('\n')}\n`,
    );
    return EXIT.ok;
  }
  const held = pending.find(item => item.path === file);
  if (held === undefined) {
    ctx.world.io.err(`${file} has no change waiting for your confirmation\n`);
    return EXIT.failure;
  }
  const result = ConfirmSchema.parse(
    await ctx.client(KERNEL).call('POST /v1/config/confirm', { body: { path: held.path, etag: held.etag } }),
  );
  if (!result.confirmed) {
    ctx.world.io.err(`${file} changed again before it could be confirmed; run ${binary(ctx)} config confirm again\n`);
    return EXIT.failure;
  }
  ctx.world.io.out(`Confirmed ${file}: ${held.changes.join('; ')}. It is in effect now.\n`);
  return EXIT.ok;
};

/** `fy config guide`: the built-in "Set up Ferretry" skill. Needs no daemon. */
export const configGuideVerb: ShellVerb = async ctx => {
  ctx.world.io.out(setUpFerretrySkill(binary(ctx)));
  return EXIT.ok;
};
