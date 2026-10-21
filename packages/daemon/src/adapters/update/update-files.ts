import { closeSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UpdateDocumentName, UpdateDocuments, UpdateLauncher, UpdateLaunchOutcome } from '../../lib/index.ts';

/** The calls the update makes on the state home's confined filesystem. */
export interface UpdateStateFiles {
  readText(path: string): Promise<string | undefined>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  ensureDirectory(path: string, mode: number): Promise<void>;
}

const FILE_NAMES: Readonly<Record<UpdateDocumentName, string>> = {
  latest: 'latest.json',
  settings: 'config.json',
  report: 'report.json',
};

/** Where each update document lives, under one directory of the state home. */
const updateFilePaths = (directory: string) => ({
  directory,
  latest: join(directory, FILE_NAMES.latest),
  settings: join(directory, FILE_NAMES.settings),
  report: join(directory, FILE_NAMES.report),
  log: join(directory, 'update.log'),
});

/**
 * The update's three documents, inside the state home: the last check, the setting, and the report
 * the client leaves when an update finishes. Unreadable reads as absent.
 */
export class FileUpdateDocuments implements UpdateDocuments {
  constructor(
    private readonly files: UpdateStateFiles,
    private readonly directory: string,
  ) {}

  async read(name: UpdateDocumentName): Promise<unknown> {
    const raw = await this.files.readText(join(this.directory, FILE_NAMES[name])).catch(() => undefined);
    if (raw === undefined || raw.trim() === '') return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  async write(name: Exclude<UpdateDocumentName, 'report'>, document: unknown): Promise<void> {
    await this.files.writeTextAtomic(join(this.directory, FILE_NAMES[name]), `${JSON.stringify(document, null, 2)}\n`);
  }

  async remove(name: 'report'): Promise<void> {
    await this.files.removeFile(join(this.directory, FILE_NAMES[name]));
  }
}

/** Starting a detached child, injected so a suite can watch the call. */
export type DetachedSpawn = (
  argv: readonly string[],
  options: { readonly environment: Readonly<Record<string, string | undefined>>; readonly logFile: string },
) => void;

function spawnDetached(
  argv: readonly string[],
  options: { readonly environment: Readonly<Record<string, string | undefined>>; readonly logFile: string },
): void {
  const log = openSync(options.logFile, 'a', 0o600);
  try {
    Bun.spawn([...argv], {
      stdin: 'ignore',
      stdout: log,
      stderr: log,
      env: { ...options.environment },
      // Its own process group, so nothing that signals the daemon's group reaches the update.
      detached: true,
    }).unref();
  } finally {
    // The child holds its own copy of the descriptor; the daemon's is not needed past the spawn.
    closeSync(log);
  }
}

export interface CliUpdateLauncherOptions {
  /** The client executable, beside the daemon's own. */
  readonly client: string;
  readonly stateHome: string;
  readonly files: UpdateStateFiles;
  /** The update directory: the report goes here, and so does the update's own log. */
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly spawn?: DetachedSpawn;
}

/**
 * `<client> daemon update --yes --to <target> --report <file>`, detached.
 *
 * `--anyway` because the daemon already decided: it refused a mid-turn update without consent, or
 * waited for idle. The child outlives the daemon's restart — the systemd unit kills only the daemon
 * (`KillMode=process`) and the launchd agent abandons its process group — and its report is the one
 * thing that crosses that restart.
 */
export class CliUpdateLauncher implements UpdateLauncher {
  private readonly spawn: DetachedSpawn;

  constructor(private readonly options: CliUpdateLauncherOptions) {
    this.spawn = options.spawn ?? spawnDetached;
  }

  async launch(target: string): Promise<UpdateLaunchOutcome> {
    const paths = updateFilePaths(this.options.directory);
    try {
      await this.options.files.ensureDirectory(dirname(paths.report), 0o700);
      this.spawn([this.options.client, 'daemon', 'update', '--yes', '--to', target, '--report', paths.report], {
        environment: { ...this.options.environment, FY_HOME: this.options.stateHome },
        logFile: paths.log,
      });
      return { kind: 'started' };
    } catch (error) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
