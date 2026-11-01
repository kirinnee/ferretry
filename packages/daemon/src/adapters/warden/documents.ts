import { join } from 'node:path';
import { type ConfigEvaluation, checkConfigFile, renderConfigFile } from '@ferretry/fleet';
import { type ConfigFileAddress, configFilePath, mergeWardenConfig, type WardenConfigPatch } from '@ferretry/protocol';
import type { ConfigFilesService } from '../../lib/config-files/index.ts';
import type {
  AutoMigrateMemory,
  WardenConfig,
  WardenConfigStore,
  WardenReportFileSystem,
  WardenRuntimeState,
  WardenStateStore,
} from '../../lib/warden/index.ts';

/**
 * The documents warden supervision reads and writes: its own state inside the state home, and the
 * owner's `config/warden.yaml`.
 *
 * THE STATE DOCUMENT READS AS `undefined` RATHER THAN THROWING, and hands the raw
 * parsed JSON up rather than a typed value: `src/lib` decides what a corrupt state
 * document MEANS — it is salvaged section by section — and an adapter that parsed
 * would duplicate that policy. The settings file is the configuration files' own:
 * last good wins there, so what is read is always a configuration that checked.
 *
 * THE STATE DOCUMENT WRITES ATOMICALLY, through the same filesystem port the reports
 * use, which creates the warden directory with owner-only permissions on first use. The state
 * document is rewritten several times inside one sweep — after detection, after the
 * assignments, after the escalation — and a torn write would lose the spawn gap or
 * the failover strikes that stop the next sweep repeating an expensive mistake.
 */

export const WARDEN_STATE_FILENAME = 'state.json';

const WARDEN_FILE: ConfigFileAddress = { kind: 'warden' };

/** Reads and writes JSON in the warden's own directory, tolerating absence. */
class WardenDocument {
  constructor(
    private readonly files: WardenReportFileSystem,
    private readonly path: string,
  ) {}

  /** The document's parsed JSON, or `undefined` when it is absent, unreadable or
   *  not JSON at all. Never throws: the caller's fallback policy is the answer to
   *  every one of those, and it lives in the domain. */
  async read(): Promise<unknown> {
    const raw = await this.files.readText(this.path).catch(() => undefined);
    if (raw === undefined || raw.trim() === '') return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  async write(value: unknown): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(value, null, 2)}\n`);
  }
}

/** The durable sweep state: what one sweep must remember for the next. */
export class FileWardenStateStore implements WardenStateStore {
  private readonly document: WardenDocument;

  constructor(files: WardenReportFileSystem, wardenRoot: string) {
    this.document = new WardenDocument(files, join(wardenRoot, WARDEN_STATE_FILENAME));
  }

  async read(): Promise<unknown> {
    return await this.document.read();
  }

  async write(state: WardenRuntimeState): Promise<void> {
    await this.document.write(state);
  }
}

/**
 * The operator's Warden settings, as `config/warden.yaml` (docs/config-files.md): read as the
 * version IN EFFECT — the last good one, and the tighter one while a loosening edit waits for the
 * owner — and written key by key, so the owner's comments survive a save from the app.
 *
 * A write from here is the owner's own act (`PATCH /v1/warden/config` is `warden.configure`), so it is
 * acknowledged and in effect at once rather than held.
 *
 * A SAVE NEVER DISCARDS A HELD EDIT. While an edit waits for the owner, the file says one thing and the
 * version in effect another; rendering the settings in effect over the file would put every held value
 * back to what is in effect — on 2026-10-29 a save of the daily caps put Jev's price back from $0.042 to
 * $2 a minute after the corrected price was written, and Jev then spent its cap twenty times too early.
 * So the owner's patch is made to both: the held edit, changed, stays in the file and stays held; the
 * version in effect, changed, is what the daemon records as accepted.
 */
export class ConfigFileWardenConfigStore implements WardenConfigStore {
  constructor(private readonly config: Pick<ConfigFilesService, 'inEffect' | 'load' | 'writeOwn'>) {}

  async read(): Promise<unknown> {
    return (await this.config.inEffect()).evaluation.effective.warden;
  }

  async write(config: WardenConfig, patch: WardenConfigPatch): Promise<void> {
    const path = configFilePath(WARDEN_FILE);
    const { files, evaluation } = await this.config.load();
    const disk = files.get(path)?.text;
    const held = heldWardenConfig(evaluation, path, disk);
    if (held === undefined) {
      const text = renderConfigFile(path, WARDEN_FILE, config, disk);
      if (text !== undefined) await this.config.writeOwn(path, text);
      return;
    }
    const accepted = evaluation.accepted[path]?.text;
    const inEffect = renderConfigFile(path, WARDEN_FILE, config, accepted) ?? accepted ?? '';
    const text = renderConfigFile(path, WARDEN_FILE, mergeWardenConfig(held.config, patch), held.text) ?? held.text;
    await this.config.writeOwn(path, text, inEffect);
  }
}

/** The edit held for the owner in `warden.yaml`, as settings and as text — `undefined` when none is. */
function heldWardenConfig(
  evaluation: ConfigEvaluation,
  path: string,
  disk: string | undefined,
): { readonly config: WardenConfig; readonly text: string } | undefined {
  // A held DELETION has no file to keep: the save writes the file again, which is the owner’s own act.
  if (disk === undefined || !evaluation.pending.some(pending => pending.path === path)) return undefined;
  const checked = checkConfigFile(path, disk);
  return checked.ok ? { config: checked.value as WardenConfig, text: disk } : undefined;
}

export const WARDEN_AUTO_MIGRATE_FILENAME = 'auto-migrate.json';

/**
 * The Warden's move ledger (`warden/auto-migrate.ts`), in its own document beside the sweep state: the mover reads
 * and writes it only under its one lock, and a sweep's state write can never carry a stale copy of it back.
 */
export class FileAutoMigrateLedger {
  private readonly document: WardenDocument;

  constructor(files: WardenReportFileSystem, wardenRoot: string) {
    this.document = new WardenDocument(files, join(wardenRoot, WARDEN_AUTO_MIGRATE_FILENAME));
  }

  async read(): Promise<unknown> {
    return await this.document.read();
  }

  async write(memory: AutoMigrateMemory): Promise<void> {
    await this.document.write(memory);
  }
}
