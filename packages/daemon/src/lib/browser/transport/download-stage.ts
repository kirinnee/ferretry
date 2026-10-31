import { join } from 'node:path';
import { BROWSER_MAX_DOWNLOAD_NOTICES, type BrowserDownloadNotice } from '@ferretry/protocol';
import { AGENT_FILE_LIMITS, STAGED_FILE_TTL_MS, sanitizeFileName } from '../../agent-files/policy.ts';

/**
 * WHERE THE WORKER KEEPS WHAT A PAGE DOWNLOADED, or printed, until the daemon saves it for the agent.
 *
 * The browser never writes into an agent's folder. A download is moved into the daemon-owned staging
 * directory under a name the worker chose, kept {@link STAGED_FILE_TTL_MS}, and reported to the agent as
 * a notice on the act that started it ("a download started: name, size"). Saving it somewhere an agent
 * may read is the DAEMON'S decision, made by the file tools, over the staged path this hands back.
 *
 * Written against a few ports so the whole life cycle is tested with a fake download and no browser.
 */

/** The slice of a Playwright `Download` this needs. */
export interface StageableDownload {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
}

export interface DownloadStageDisk {
  mkdirp(directory: string): Promise<void>;
  size(path: string): Promise<number>;
  remove(path: string): Promise<void>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export interface DownloadStageOptions {
  /** Absent when the daemon named no staging directory: nothing is staged and nothing is reported. */
  readonly directory: string | undefined;
  readonly disk: DownloadStageDisk;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly ttlMs?: number;
  readonly maxBytes?: number;
}

export interface StagedDownload {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

type Entry = {
  readonly id: string;
  readonly pageId: string;
  readonly kind: 'download' | 'pdf';
  readonly name: string;
  readonly path: string;
  readonly at: number;
  readonly serial: number;
  state: 'downloading' | 'ready' | 'failed';
  size?: number;
  reported: boolean;
  done: Promise<void>;
};

/** How long an act waits for a download it just started to show its size before reporting it as running. */
export const DOWNLOAD_SETTLE_MS = 3_000;
/** How long a save waits for a running download, or for one to start. */
export const DOWNLOAD_CLAIM_WAIT_MS = 45_000;
const POLL_MS = 100;

export class DownloadStage {
  private readonly entries = new Map<string, Entry>();
  private serial = 0;

  private readonly options: DownloadStageOptions;

  constructor(options: DownloadStageOptions) {
    this.options = options;
  }

  /** Begins staging one download a page started. Never throws: a failure is the entry's `failed` state. */
  accept(pageId: string, download: StageableDownload): void {
    const { directory } = this.options;
    if (directory === undefined) return;
    this.prune();
    this.serial += 1;
    const id = `dl-${this.serial.toString(36)}`;
    const name = sanitizeFileName(download.suggestedFilename(), 'download');
    const path = join(directory, `${id}-${name}`);
    const entry: Entry = {
      id,
      pageId,
      kind: 'download',
      name,
      path,
      at: this.options.now(),
      serial: this.serial,
      state: 'downloading',
      reported: false,
      done: Promise.resolve(),
    };
    entry.done = this.stage(entry, download);
    this.entries.set(id, entry);
  }

  private async stage(entry: Entry, download: StageableDownload): Promise<void> {
    const { disk, directory } = this.options;
    try {
      await disk.mkdirp(directory as string);
      await download.saveAs(entry.path);
      const size = await disk.size(entry.path);
      if (size > (this.options.maxBytes ?? AGENT_FILE_LIMITS.downloadBytes)) {
        entry.state = 'failed';
        await disk.remove(entry.path).catch(() => undefined);
        return;
      }
      entry.size = size;
      entry.state = 'ready';
    } catch {
      entry.state = 'failed';
      await disk.remove(entry.path).catch(() => undefined);
    }
  }

  /** A page printed to PDF: written to the staging directory and offered to the next save, never announced. */
  async stagePdf(pageId: string, base64: string, title: string): Promise<StagedDownload> {
    const { directory, disk } = this.options;
    if (directory === undefined) throw new Error('this browser has no place to stage a PDF');
    const maxBytes = this.options.maxBytes ?? AGENT_FILE_LIMITS.downloadBytes;
    if (Math.floor((base64.length * 3) / 4) > maxBytes)
      throw new Error('that page prints to a PDF larger than the save limit');
    this.prune();
    this.serial += 1;
    const id = `pdf-${this.serial.toString(36)}`;
    const stem = sanitizeFileName(title.replace(/\.pdf$/iu, ''), 'page');
    const name = `${stem}.pdf`;
    const path = join(directory, `${id}-${name}`);
    const bytes = Buffer.from(base64, 'base64');
    await disk.mkdirp(directory);
    await disk.write(path, bytes);
    this.entries.set(id, {
      id,
      pageId,
      kind: 'pdf',
      name,
      path,
      at: this.options.now(),
      serial: this.serial,
      state: 'ready',
      size: bytes.byteLength,
      reported: true,
      done: Promise.resolve(),
    });
    return { path, name, size: bytes.byteLength };
  }

  /**
   * What this page's downloads have to tell the agent since it last asked: each finished or failed one
   * once, a running one every time until it ends. Waits briefly for a download that has just started to
   * know its size.
   */
  async notices(pageId: string): Promise<readonly BrowserDownloadNotice[]> {
    this.prune();
    const open = [...this.entries.values()].filter(
      entry =>
        entry.pageId === pageId && entry.kind === 'download' && (!entry.reported || entry.state === 'downloading'),
    );
    if (open.length === 0) return [];
    await Promise.race([Promise.all(open.map(entry => entry.done)), this.options.sleep(DOWNLOAD_SETTLE_MS)]);
    const notices: BrowserDownloadNotice[] = [];
    for (const entry of open.slice(0, BROWSER_MAX_DOWNLOAD_NOTICES)) {
      if (entry.state !== 'downloading') entry.reported = true;
      notices.push({
        id: entry.id,
        name: entry.name,
        state: entry.state,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      });
    }
    return notices;
  }

  /** Waits a moment for a download a click has just caused to be announced by the browser. */
  async awaitStart(pageId: string, settleMs: number): Promise<void> {
    const before = this.latest(pageId)?.serial ?? 0;
    for (let waited = 0; waited < settleMs; waited += POLL_MS) {
      if ((this.latest(pageId)?.serial ?? 0) > before) return;
      await this.options.sleep(POLL_MS);
    }
  }

  private latest(pageId: string): Entry | undefined {
    let found: Entry | undefined;
    for (const entry of this.entries.values())
      if (entry.pageId === pageId && entry.kind === 'download' && (found === undefined || entry.serial > found.serial))
        found = entry;
    return found;
  }

  /** The chosen download of this page, or its latest, once it is whole. */
  async claim(pageId: string, id?: string): Promise<StagedDownload> {
    this.prune();
    let entry: Entry | undefined;
    if (id === undefined) {
      for (let waited = 0; this.latest(pageId) === undefined && waited < DOWNLOAD_SETTLE_MS; waited += POLL_MS)
        await this.options.sleep(POLL_MS);
      entry = this.latest(pageId);
      if (entry === undefined) throw new Error('this page has not started a download');
    } else {
      entry = this.entries.get(id);
      if (entry === undefined || entry.pageId !== pageId || entry.kind !== 'download')
        throw new Error(`no download ${id} on this page — downloads are kept for 15 minutes`);
    }
    await Promise.race([entry.done, this.options.sleep(DOWNLOAD_CLAIM_WAIT_MS)]);
    if (entry.state === 'downloading') throw new Error(`${entry.id} is still downloading — try again shortly`);
    if (entry.state === 'failed' || entry.size === undefined) throw new Error(`${entry.id} did not finish downloading`);
    return { path: entry.path, name: entry.name, size: entry.size };
  }

  /** Forgets, and deletes, whatever has been waiting longer than the keep time. */
  prune(): void {
    const ttl = this.options.ttlMs ?? STAGED_FILE_TTL_MS;
    const now = this.options.now();
    for (const [id, entry] of this.entries)
      if (now - entry.at > ttl && entry.state !== 'downloading') {
        this.entries.delete(id);
        void this.options.disk.remove(entry.path).catch(() => undefined);
      }
  }
}
