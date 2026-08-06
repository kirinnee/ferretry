/**
 * The operator's resource-limit configuration: whether limits are enforced at all, the aggregate
 * ceiling every managed agent shares, and the ceiling applied independently to each one.
 *
 * WHERE IT LIVES. In its own document inside the state home (`cgroups/config.json`), not in
 * `config/daemon.json`. That is this repository's established shape — the warden's configuration,
 * the self-restart stamp, the health event log and the pin store are each one document about one
 * subject — and the reason is a torn write: a read-modify-write of a file holding every unrelated
 * subsystem's settings can lose a host binding when only a CPU percentage was being changed.
 *
 * TOLERANT ON GET, STRICT ON PATCH. A stored document that no longer validates falls back to the
 * defaults and SAYS SO in a warning, because the defaults are the safe direction: `enabled: false`
 * means a configuration this daemon cannot understand can never cap anything. A document that
 * EXISTS BUT CANNOT BE READ also falls back for GET, but carries machine-readable failure evidence
 * so PATCH can refuse before writing: merging a partial edit onto defaults would otherwise erase
 * the unreadable intent. A patch is parsed strictly too — an operator naming a field that does not
 * exist has made a mistake worth refusing, not worth silently dropping.
 *
 * WHY THE DEFAULT IS OFF, where the proven reference defaults Linux on. In that reference the
 * wrapper was written into a generated launcher script; here every managed session is launched
 * through one composition seam, so a host with the unified hierarchy but no reachable user manager
 * would fail EVERY session start rather than one. Enforcement is therefore opt-in, exactly as
 * warden escalation is, and `supported` still gates whether the opt-in may be taken at all.
 *
 * Pure: no IO, no clock, no globals.
 */

import { type CgroupConfig, type CgroupConfigPatch, CgroupConfigSchema } from '@ferretry/protocol';

/** The configuration a state home with no cgroup document behaves as. */
export const defaultCgroupConfig: CgroupConfig = {
  // OFF. Nothing is capped until an operator asks for it — see the header for why this daemon
  // cannot safely default the other way.
  enabled: false,
  // The aggregate leaves a tenth of the machine for everything that is NOT an agent: this daemon,
  // the terminal multiplexer, and the person's own shell. That headroom is the whole point of an
  // aggregate ceiling, so it is part of the default rather than something to discover.
  fleet: { cpuPercent: 90, memoryPercent: 90 },
  // A quarter of the host to any single agent, so one runaway cannot consume the aggregate it
  // shares with every sibling.
  perAgent: { cpuPercent: 25, memoryPercent: 25 },
};

export interface StoredCgroupConfig {
  readonly config: CgroupConfig;
  /** Non-empty exactly when the stored document could not be used as written. */
  readonly warnings: readonly string[];
  /** Set only when a document exists but the adapter could not read it. GET may show safe defaults,
   *  while PATCH must refuse rather than merging onto those defaults and overwriting unknown
   *  operator intent. */
  readonly readFailure?: string;
}

/**
 * Raw evidence that a persisted cgroup document exists at a path the adapter could not read.
 *
 * The stores return raw values so the domain owns fallback policy. This error therefore travels as
 * a VALUE rather than being thrown through the settings route: treating it as `undefined` would
 * make EACCES/EIO indistinguishable from a fresh state home, while throwing would take the whole
 * panel down instead of showing the operator what could not be established.
 */
export class CgroupDocumentReadFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CgroupDocumentReadFailure';
  }
}

/**
 * The first validation failure, in the operator's vocabulary.
 *
 * Only the first: the point of the message is to name something the operator can go and fix, and a
 * document that fails one field usually fails several for the same reason. A failure with no field
 * path is about the document as a whole — it was not an object at all.
 */
export function cgroupIssueSummary(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .slice(0, 1)
    .map(issue => `${issue.path.length === 0 ? 'document' : issue.path.map(String).join('.')}: ${issue.message}`)
    .join('');
}

/**
 * The configuration a persisted document means.
 *
 * `undefined` — no document yet — is the normal first-boot situation and yields the defaults with no
 * warning. Anything present but invalid yields the defaults WITH a warning: the surface that reports
 * resource limits must not go dark because one document was hand-edited, and the warning is what
 * stops the fallback from being silent.
 */
export function parseStoredCgroupConfig(value: unknown): StoredCgroupConfig {
  if (value === undefined || value === null) return { config: defaultCgroupConfig, warnings: [] };
  if (value instanceof CgroupDocumentReadFailure)
    return {
      config: defaultCgroupConfig,
      readFailure: value.message,
      warnings: [
        `the stored resource-limit configuration could not be read (${value.message}); defaults are in effect and enforcement is off`,
      ],
    };
  const parsed = CgroupConfigSchema.safeParse(value);
  if (parsed.success) return { config: parsed.data, warnings: [] };
  return {
    config: defaultCgroupConfig,
    warnings: [
      `the stored resource-limit configuration did not validate (${cgroupIssueSummary(parsed.error.issues)}); defaults are in effect and enforcement is off`,
    ],
  };
}

/**
 * Apply an operator patch, both limit sections merged rather than replaced.
 *
 * `fleet` and `perAgent` merge one level deeper because both are declared `.partial()` on the wire:
 * an operator lowering the fleet CPU share must not thereby reset its memory share to whatever a
 * fresh object would carry.
 *
 * The result is re-parsed through the FULL schema, so a merge cannot produce a document the loader
 * would later refuse — in particular the cross-field rule that no per-agent share may exceed its
 * fleet counterpart holds on the way out, not only on the way in.
 */
export function applyCgroupConfigPatch(config: CgroupConfig, patch: CgroupConfigPatch): CgroupConfig {
  return CgroupConfigSchema.parse({
    ...config,
    ...patch,
    fleet: { ...config.fleet, ...(patch.fleet ?? {}) },
    perAgent: { ...config.perAgent, ...(patch.perAgent ?? {}) },
  });
}

/**
 * True when a strictly-parsed patch asks for nothing.
 *
 * An empty patch is a caller mistake rather than a safe no-op: answering it with the unchanged
 * configuration would report success for an operation that did not happen.
 *
 * A PRESENT BUT EMPTY SECTION COUNTS AS NOTHING, which is why this reads the sections rather than
 * only the three top-level keys. Both limit sections are `.partial()` on the wire, so `{"fleet":{}}`
 * parses, names a field, and still asks for no change — and a shape check that stopped at
 * `fleet !== undefined` would answer it with a success the operator's UI would then display as a
 * saved edit.
 */
export function isEmptyCgroupConfigPatch(patch: CgroupConfigPatch): boolean {
  const emptySection = (section: CgroupConfigPatch['fleet']): boolean =>
    section === undefined || (section.cpuPercent === undefined && section.memoryPercent === undefined);
  return patch.enabled === undefined && emptySection(patch.fleet) && emptySection(patch.perAgent);
}
