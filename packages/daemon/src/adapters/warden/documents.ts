import { join } from 'node:path';
import type {
  WardenConfig,
  WardenConfigStore,
  WardenReportFileSystem,
  WardenRuntimeState,
  WardenStateStore,
} from '../../lib/warden/index.ts';

/**
 * The two documents warden supervision owns inside the state home.
 *
 * BOTH READ AS `undefined` RATHER THAN THROWING, and both hand the raw parsed JSON
 * up rather than a typed value. The parsing belongs to the domain: `src/lib`
 * decides what a corrupt state document or an invalid configuration MEANS, and
 * those decisions are not the same — a bad configuration falls back to defaults and
 * warns, while a bad state document is salvaged section by section. An adapter that
 * parsed would have to duplicate both policies, and the copy would drift.
 *
 * BOTH WRITE ATOMICALLY, through the same filesystem port the reports use, which
 * creates the warden directory with owner-only permissions on first use. The state
 * document is rewritten several times inside one sweep — after detection, after the
 * assignments, after the escalation — and a torn write would lose the spawn gap or
 * the failover strikes that stop the next sweep repeating an expensive mistake.
 */

export const WARDEN_STATE_FILENAME = 'state.json';
export const WARDEN_CONFIG_FILENAME = 'config.json';

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

/** The operator's warden configuration, in its own document rather than folded
 *  into `config/daemon.json` — see `lib/warden/config.ts` for why. */
export class FileWardenConfigStore implements WardenConfigStore {
  private readonly document: WardenDocument;

  constructor(files: WardenReportFileSystem, wardenRoot: string) {
    this.document = new WardenDocument(files, join(wardenRoot, WARDEN_CONFIG_FILENAME));
  }

  async read(): Promise<unknown> {
    return await this.document.read();
  }

  async write(config: WardenConfig): Promise<void> {
    await this.document.write(config);
  }
}
