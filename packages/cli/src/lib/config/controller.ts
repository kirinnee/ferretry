import { type ConfigCheckContext, configJsonSchema, evaluateConfigFiles, setUpFerretrySkill } from '@ferretry/fleet';
import {
  CONFIG_SCHEMA_IDS,
  ConfigInvalidBodySchema,
  type ConfigIssue,
  type ConfigPending,
  ConfigSchemaIdSchema,
  classifyConfigPath,
} from '@ferretry/protocol';
import type { IConfigFiles, IConfigGateway, IConfigInput, IConfigOutput } from './ports.ts';

/** Options every `fy config` verb that prints a payload accepts. */
export interface ConfigCommandOptions {
  /** Print the payload as JSON instead of the human rendering. */
  readonly json?: boolean;
}

/** Options `fy config write` accepts. */
export interface ConfigWriteOptions {
  /** The etag the text was edited against; the write is refused if the file moved since. */
  readonly ifMatch?: string;
}

/** A refusal `fy config` says in one sentence and exits non-zero on. */
export class ConfigCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigCommandError';
  }
}

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** One issue as a line a person (or an agent) can jump to: `path:line:col severity: message`, then the fix. */
export function renderIssue(issue: ConfigIssue): string {
  const where = issue.line === undefined ? issue.path : `${issue.path}:${String(issue.line)}:${String(issue.column)}`;
  return `${where} ${issue.severity}: ${issue.message}\n  fix: ${issue.fix}`;
}

/** One held edit, and the command that confirms it. */
export function renderPending(pending: ConfigPending, bin: string): string {
  return `${pending.path} waits for your confirmation: ${pending.changes.join('; ')}\n  confirm: ${bin} config confirm ${pending.path}`;
}

/** The whole report: every issue, every held edit, and one summary line. */
export function renderConfigReport(
  report: {
    readonly files: number;
    readonly issues: readonly ConfigIssue[];
    readonly pending: readonly ConfigPending[];
  },
  bin: string,
): string {
  const errors = report.issues.filter(issue => issue.severity === 'error').length;
  const warnings = report.issues.length - errors;
  const lines = [
    ...report.issues.map(renderIssue),
    ...report.pending.map(pending => renderPending(pending, bin)),
    `${plural(report.files, 'file')} checked: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}, ${String(report.pending.length)} waiting for confirmation.`,
  ];
  return lines.join('\n');
}

/**
 * Drives `fy config …` (docs/config-files.md).
 *
 * `path`, `check`, `schema` and `guide` need no daemon: an agent can find the files, learn their shape
 * and check its own edit on a machine whose daemon is stopped. `status` and `confirm` ask the daemon,
 * because what is IN EFFECT, and the owner's confirmation of an edit that loosens, are the daemon's.
 */
export class ConfigController {
  constructor(
    private readonly files: IConfigFiles,
    private readonly gateway: IConfigGateway,
    private readonly out: IConfigOutput,
    private readonly bin: string,
    private readonly digest: (text: string) => string,
    private readonly input: IConfigInput,
    /** What the daemon also checks against this machine: the component-source fence over its state home. */
    private readonly checkContext: ConfigCheckContext = {},
  ) {}

  /** The config directory, or one file in it, absolute. */
  path(file: string | undefined): void {
    if (file === undefined) {
      this.out.success(this.files.directory);
      return;
    }
    if (classifyConfigPath(file) === undefined) {
      throw new ConfigCommandError(
        `${file} is not a Ferretry configuration file — use machine.yaml, warden.yaml, learning.yaml, voice.yaml, logins/<id>.yaml, profiles/<name>.yaml, runtimes/<name>.yaml or components/<kind>/<name>.yaml`,
      );
    }
    this.out.success(`${this.files.directory}/${file}`);
  }

  /** Check every file here, as the daemon would. Exits non-zero when any file has an error. */
  async check(options: ConfigCommandOptions): Promise<void> {
    const { files, unreadable } = await this.files.list();
    const evaluation = evaluateConfigFiles({
      files,
      unreadable,
      accepted: await this.files.accepted(),
      digest: text => this.digest(text),
      context: this.checkContext,
    });
    const report = { files: evaluation.files.length, issues: evaluation.issues, pending: evaluation.pending };
    this.out.success(options.json === true ? JSON.stringify(report, null, 2) : renderConfigReport(report, this.bin));
    if (evaluation.issues.some(issue => issue.severity === 'error')) this.out.setExitCode(1);
  }

  /** What the daemon has in effect, and what it reported. */
  async status(options: ConfigCommandOptions): Promise<void> {
    const status = await this.gateway.status();
    this.out.success(
      options.json === true
        ? JSON.stringify(status, null, 2)
        : `${status.directory}\n${renderConfigReport({ files: status.files.length, issues: status.issues, pending: status.pending }, this.bin)}`,
    );
  }

  /** A kind's JSON Schema, or the list of kinds. */
  schema(kind: string | undefined): void {
    if (kind === undefined) {
      this.out.success(CONFIG_SCHEMA_IDS.join('\n'));
      return;
    }
    const id = ConfigSchemaIdSchema.safeParse(kind);
    if (!id.success) throw new ConfigCommandError(`no kind ${kind} — one of ${CONFIG_SCHEMA_IDS.join(', ')}`);
    this.out.success(JSON.stringify(configJsonSchema(id.data), null, 2));
  }

  /**
   * Confirm the edit to `file` that is waiting, as the daemon holds it now. Without a file, list what
   * waits. The daemon answers only at this machine; a remote device confirms in the app with a passkey.
   */
  async confirm(file: string | undefined): Promise<void> {
    const { pending } = await this.gateway.status();
    if (file === undefined) {
      this.out.success(
        pending.length === 0
          ? 'Nothing is waiting for your confirmation.'
          : pending.map(item => renderPending(item, this.bin)).join('\n'),
      );
      return;
    }
    const held = pending.find(item => item.path === file);
    if (held === undefined) throw new ConfigCommandError(`${file} has no change waiting for your confirmation`);
    const result = await this.gateway.confirm(held.path, held.etag);
    if (!result.confirmed) {
      throw new ConfigCommandError(
        `${file} changed again before it could be confirmed; run ${this.bin} config confirm again`,
      );
    }
    this.out.success(`Confirmed ${file}: ${held.changes.join('; ')}. It is in effect now.`);
  }

  /** One file as the daemon holds it: where it stands, its etag, its issues, and its text. */
  async show(file: string, options: ConfigCommandOptions): Promise<void> {
    const view = await this.gateway.file(file);
    if (options.json === true) {
      this.out.success(JSON.stringify(view, null, 2));
      return;
    }
    const state = view.exists ? view.state : 'does not exist yet — this is the starter a new one begins with';
    this.out.success(
      [`${view.absolutePath} (${state})`, `etag: ${view.etag}`, ...view.issues.map(renderIssue), '', view.text].join(
        '\n',
      ),
    );
  }

  /**
   * Write a file through the daemon, from standard input: refused whole unless it checks, and refused
   * if the file moved since `--if-match`. At this machine a loosening is in effect at once.
   */
  async write(file: string, options: ConfigWriteOptions): Promise<void> {
    const text = await this.input.read();
    let written: Awaited<ReturnType<IConfigGateway['write']>>;
    try {
      written = await this.gateway.write(file, text, options.ifMatch);
    } catch (error) {
      const invalid = ConfigInvalidBodySchema.safeParse((error as { readonly body?: unknown }).body);
      if (!invalid.success) throw error;
      this.out.success(invalid.data.issues.map(renderIssue).join('\n'));
      throw new ConfigCommandError(invalid.data.error);
    }
    this.out.success(
      written.outcome === 'applied'
        ? `Wrote ${file}; it is in effect (etag ${written.etag}).`
        : `Wrote ${file}; it waits for your confirmation: ${(written.pending?.changes ?? []).join('; ')}.\n  confirm: ${this.bin} config confirm ${file}`,
    );
  }

  /** The built-in "Set up Ferretry" skill, as a SKILL.md. */
  guide(): void {
    this.out.success(setUpFerretrySkill(this.bin));
  }
}
