import { join } from 'node:path';
import { renderConfigFile } from '@ferretry/fleet';
import { type ConfigFileAddress, configFilePath } from '@ferretry/protocol';
import type { ConfigFilesService } from '../../lib/config-files/index.ts';
import type {
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
 */
export class ConfigFileWardenConfigStore implements WardenConfigStore {
  constructor(private readonly config: Pick<ConfigFilesService, 'inEffect' | 'load' | 'writeOwn'>) {}

  async read(): Promise<unknown> {
    return (await this.config.inEffect()).evaluation.effective.warden;
  }

  async write(config: WardenConfig): Promise<void> {
    const path = configFilePath(WARDEN_FILE);
    const { files } = await this.config.load();
    const text = renderConfigFile(path, WARDEN_FILE, config, files.get(path)?.text);
    if (text !== undefined) await this.config.writeOwn(path, text);
  }
}
