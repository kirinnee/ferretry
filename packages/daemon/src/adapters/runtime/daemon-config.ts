import {
  type DaemonConfig,
  DaemonConfigDocumentSchema,
  defaultDaemonConfigDocument,
  parseDaemonConfig,
  type FileSystemPort,
  type FoundationPaths,
} from '../../lib/index.ts';

/** Durable daemon configuration adapter; the state filesystem keeps the document private and atomic. */
export class FileDaemonConfig {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {}

  /** The document an operator edits, so a refusal can name the file rather than describe it. */
  get path(): string {
    return this.paths.daemonConfig;
  }

  /**
   * The configuration this daemon runs on, seeding the document on a state home that has none.
   *
   * WHAT IS SEEDED IS THE DOCUMENT, never the parsed result. The parsed result carries addresses
   * derived from `host` and `port`, and writing those back made them look like an operator's own
   * choices: from then on `publicUrl` no longer tracked `port`, so changing the port moved the bind
   * and left everything that reads the advertised address — the incumbent probe included — pointing
   * at the old one. Editing `port` therefore appeared to do nothing at all. Derived values are
   * recomputed on every load instead, which is the only arrangement in which the two cannot disagree.
   */
  /**
   * The configuration as it stands, WITHOUT writing anything.
   *
   * A separate verb from `load` because `load` seeds the document on a state home that has none, and
   * a question must never provision. `fyd --print-config` and `fyd --check` exist precisely for the
   * operator who cannot get a boot to work; creating their state home as a side effect of asking
   * would be the `--version` defect all over again.
   *
   * The RAW document comes back beside the parsed one because provenance needs it: whether a value
   * was written down or defaulted is exactly the question, and the parsed form has already lost it.
   */
  async peek(): Promise<{ readonly document: Record<string, unknown> | undefined; readonly config: DaemonConfig }> {
    const text = await this.files.readText(this.paths.daemonConfig);
    if (text === undefined) return { document: undefined, config: parseDaemonConfig({}) };
    const document = JSON.parse(text) as Record<string, unknown>;
    return { document, config: parseDaemonConfig(document) };
  }

  async load(): Promise<DaemonConfig> {
    const text = await this.files.readText(this.paths.daemonConfig);
    if (text === undefined) {
      const document = defaultDaemonConfigDocument();
      await this.files.writeTextAtomic(this.paths.daemonConfig, `${JSON.stringify(document, null, 2)}\n`);
      return parseDaemonConfig(document);
    }
    return parseDaemonConfig(JSON.parse(text));
  }

  /**
   * Writes down the address this daemon took, so it is the same one next time.
   *
   * RECORDING IS WHAT MAKES CHOOSING SAFE. A daemon that picked a free port on every boot would move
   * whenever the machine's port usage changed, and every client that had learned where it lived
   * would be wrong for reasons nobody could see. Written once, the port stops being a choice and
   * becomes a claim: the next boot binds exactly this or refuses.
   *
   * THE DOCUMENT IS RE-READ rather than rewritten from the parsed configuration, because the parsed
   * form carries derived addresses and persisting one of those is the defect this whole file was
   * corrected for. Re-reading also means an operator's own fields survive untouched — this writes
   * exactly one key.
   */
  async record(port: number): Promise<void> {
    const text = await this.files.readText(this.paths.daemonConfig);
    const document = DaemonConfigDocumentSchema.parse(text === undefined ? {} : JSON.parse(text));
    await this.files.writeTextAtomic(this.paths.daemonConfig, `${JSON.stringify({ ...document, port }, null, 2)}\n`);
  }
}
