import { type CapabilityGrants, DAEMON_CAPABILITIES, type DaemonCapability } from '@ferretry/protocol';
import {
  type DaemonConfig,
  DaemonConfigDocumentSchema,
  defaultDaemonConfigDocument,
  type FileSystemPort,
  type FoundationPaths,
  parseDaemonConfig,
  recordedPortDocument,
} from '../../lib/index.ts';

/**
 * A configuration document this daemon will not act on, named so a person can go and fix it.
 *
 * IT EXISTS BECAUSE REFUSING IS ONLY HALF THE CONTRACT. A malformed document already stopped the
 * daemon — the schema is strict and nothing falls back to a default — but what reached the operator
 * was a raw validation dump with no file path in it, which is the "non-zero exit that explains
 * nothing" this package has already corrected once for occupied addresses. The cause travels intact
 * underneath, because the field name in it is the actual answer.
 */
export class DaemonConfigDocumentError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(
      `${path} could not be read as a configuration document, so this daemon will not act on it: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'DaemonConfigDocumentError';
    this.cause = cause;
  }
}

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
    const document = this.parsed(text) as Record<string, unknown>;
    return { document, config: this.configured(document) };
  }

  async load(): Promise<DaemonConfig> {
    const text = await this.files.readText(this.paths.daemonConfig);
    if (text === undefined) {
      const document = defaultDaemonConfigDocument();
      await this.files.writeTextAtomic(this.paths.daemonConfig, `${JSON.stringify(document, null, 2)}\n`);
      return parseDaemonConfig(document);
    }
    return this.configured(this.parsed(text));
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
   *
   * WHICH key is `recordedPortDocument`'s decision, not this adapter's: a document with an explicit
   * bind carrier reads its address from that entry, and the top-level `port` is superseded there.
   *
   * WHAT IS WRITTEN IS THE RAW DOCUMENT, not the schema's reading of it. The schema still runs — a
   * document this daemon would refuse to boot on is not one it may write over — but its OUTPUT is
   * deliberately discarded, because it carries every default this deployment filled in, and a default
   * on disk is indistinguishable from a line the operator typed. That is not a cosmetic difference:
   * `supersededCarrierKeys` reports a legacy key by its PRESENCE, so a materialized `host` turned
   * every later boot into an accusation about a key that is not in their file.
   */
  async record(port: number): Promise<void> {
    const text = await this.files.readText(this.paths.daemonConfig);
    const raw = this.raw(text);
    this.checked(raw);
    await this.files.writeTextAtomic(
      this.paths.daemonConfig,
      `${JSON.stringify(recordedPortDocument(raw, port), null, 2)}\n`,
    );
  }

  /**
   * What this machine has agreed a non-loopback caller may do.
   *
   * A DOCUMENT WITH NO `grants` KEY IS A COMPLETE ANSWER, not a missing one: the schema fills every
   * axis with the product default, so an operator who has never thought about this gets the permissive
   * behaviour the product promises. A document whose `grants` key is WRONG — an unknown capability, a
   * string where a boolean belongs — throws, and the subsystem above turns that into denied rather
   * than into a guess. Silence and damage are different things.
   */
  async readGrants(): Promise<CapabilityGrants> {
    const text = await this.files.readText(this.paths.daemonConfig);
    return this.document(text).grants;
  }

  /**
   * Which capabilities the operator actually NAMED in the document.
   *
   * Read from the RAW document rather than the parsed one, because parsing has already replaced every
   * omission with a default — and an operator may legitimately write a value identical to one. So
   * provenance cannot be recovered by comparison; it has to be read from what is on disk. It is the
   * same distinction `--print-config` exists to draw for every other value.
   */
  async writtenGrants(): Promise<readonly DaemonCapability[]> {
    const text = await this.files.readText(this.paths.daemonConfig);
    if (text === undefined) return [];
    const written = (this.parsed(text) as { readonly grants?: Record<string, unknown> | null }).grants;
    if (written === undefined || written === null) return [];
    return DAEMON_CAPABILITIES.filter(capability => written[capability] !== undefined);
  }

  /**
   * Records a change to the grants.
   *
   * The RAW document is re-read and exactly one key rewritten, for the reason `record` does the same:
   * an operator's own fields must survive a write this daemon makes, and rewriting from a parsed
   * configuration would persist derived addresses that then stop tracking what they were derived
   * from. The schema still runs, as the refusal it has always been — this daemon does not write over
   * a document it could not act on — and its defaulted output is discarded, because a default on disk
   * is indistinguishable from a line the operator typed. Turning the settings on from the UI must not
   * be a way to have a `host` key appear in their file and be reported back at them as superseded.
   */
  async writeGrants(grants: CapabilityGrants): Promise<void> {
    const text = await this.files.readText(this.paths.daemonConfig);
    const raw = this.raw(text);
    this.checked(raw);
    await this.files.writeTextAtomic(this.paths.daemonConfig, `${JSON.stringify({ ...raw, grants }, null, 2)}\n`);
  }

  /**
   * Every read of this file goes through these three, so a malformed document is refused with the
   * SAME sentence wherever it is met — the boot, the two queries, and the grant surface.
   *
   * The JSON parse and the schema parse are both wrapped, because they fail for the same reason from
   * an operator's point of view: the file they edited is not one this daemon can act on. Splitting
   * them would give the same mistake two different faces.
   */
  private parsed(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new DaemonConfigDocumentError(this.paths.daemonConfig, error);
    }
  }

  private document(text: string | undefined): ReturnType<typeof DaemonConfigDocumentSchema.parse> {
    return this.checked(this.raw(text));
  }

  /** The file as JSON and nothing more: no schema, no defaults, no coercions. A state home that has
   *  no document yet reads as the empty one, which is what every caller here already meant by it. */
  private raw(text: string | undefined): Record<string, unknown> {
    return text === undefined ? {} : (this.parsed(text) as Record<string, unknown>);
  }

  /** The refusal, separated from the reading, so `record` can hold a document to this bar without
   *  writing the defaulted result of it back over the operator's own file. */
  private checked(raw: unknown): ReturnType<typeof DaemonConfigDocumentSchema.parse> {
    const parsed = DaemonConfigDocumentSchema.safeParse(raw);
    if (!parsed.success) throw new DaemonConfigDocumentError(this.paths.daemonConfig, parsed.error);
    return parsed.data;
  }

  private configured(document: unknown): DaemonConfig {
    try {
      return parseDaemonConfig(document);
    } catch (error) {
      throw new DaemonConfigDocumentError(this.paths.daemonConfig, error);
    }
  }
}
