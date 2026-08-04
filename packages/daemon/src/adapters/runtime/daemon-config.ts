import {
  type DaemonConfig,
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
  async load(): Promise<DaemonConfig> {
    const text = await this.files.readText(this.paths.daemonConfig);
    if (text === undefined) {
      const document = defaultDaemonConfigDocument();
      await this.files.writeTextAtomic(this.paths.daemonConfig, `${JSON.stringify(document, null, 2)}\n`);
      return parseDaemonConfig(document);
    }
    return parseDaemonConfig(JSON.parse(text));
  }
}
