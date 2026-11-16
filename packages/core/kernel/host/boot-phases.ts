/**
 * Where the boot time went. The host marks the START of each boot phase (`home`, `lock`, `identity`, `config`, …,
 * `state:<plugin>`, `build:<plugin>`, `listen`, `jobs`); a phase lasts until the next mark, and the last until the
 * daemon says it is serving. The recorder also keeps the `trace` (the order the boot-trace test asserts), so a phase
 * has one spelling.
 *
 * The line it renders is for an operator reading a slow start from the log, so it carries ONLY phase names and
 * millisecond durations. A plugin id is named (it is a manifest id the host itself holds); anything else a label
 * carried — a path, an account or runtime name, a config value — is never printed: such a phase is counted by its kind.
 */

/** Phases that run once, in boot order. A label with a suffix after the kind is still this phase, and the suffix is dropped. */
const SINGLE_PHASES: ReadonlySet<string> = new Set([
  'home',
  'lock',
  'identity',
  'config',
  'check',
  'bind',
  'snapshot',
  'mount',
  'listen',
  'jobs',
]);
/** Phases that repeat once per plugin (or carrier): listed as a total, with the slowest few named. */
const PER_PLUGIN_PHASES: ReadonlySet<string> = new Set(['state', 'build', 'beforeListen', 'carrier']);
/** The carriers the kernel starts: a fixed vocabulary, so a carrier key is a name the host owns, never a value. */
const CARRIER_KEYS: readonly string[] = ['direct', 'relay', 'tunnel', 'webrtc'];
/** A phase that is not one of the above, counted under this kind rather than under what its label said. */
const OTHER_KIND = 'other';
/** How many of the slowest plugins a repeated phase names. */
const NAMED_SLOWEST = 3;

export interface BootPhases {
  /** Marks the start of a phase and appends the label to the boot trace. */
  mark(label: string): void;
  /** The one line that says each phase's duration, in boot order. `knownIds` are the plugin ids the host holds. */
  line(knownIds: ReadonlySet<string>): string;
}

interface Mark {
  readonly label: string;
  readonly at: number;
}

interface Tally {
  readonly kind: string;
  ms: number;
  readonly named: Map<string, number>;
}

/** `nowMs` is the kernel clock's (never `Date.now`); `trace` is the host's boot trace, which every mark extends. */
export function createBootPhases(nowMs: () => number, trace: string[]): BootPhases {
  const marks: Mark[] = [];
  let told = false;
  return {
    mark(label) {
      trace.push(label);
      // Once the line is told nothing reads the marks, so a later carrier change adds to the trace only.
      if (!told) marks.push({ label, at: nowMs() });
    },
    line(knownIds) {
      told = true;
      const end = nowMs();
      const tallies = new Map<string, Tally>();
      marks.forEach((mark, index) => {
        const ms = Math.max(0, Math.round((marks[index + 1]?.at ?? end) - mark.at));
        const { kind, id } = classify(mark.label, knownIds);
        const tally = tallies.get(kind) ?? { kind, ms: 0, named: new Map<string, number>() };
        tally.ms += ms;
        if (id !== undefined) tally.named.set(id, (tally.named.get(id) ?? 0) + ms);
        tallies.set(kind, tally);
      });
      const first = marks[0]?.at ?? end;
      const parts = [...tallies.values()].map(render);
      return `boot phases: ${parts.join(', ')}; total ${Math.max(0, Math.round(end - first))}ms`;
    },
  };
}

/** The kind of a label, and the plugin it names when the kind repeats per plugin and the plugin is one the host knows. */
function classify(label: string, knownIds: ReadonlySet<string>): { kind: string; id?: string } {
  const colon = label.indexOf(':');
  const kind = colon < 0 ? label : label.slice(0, colon);
  const suffix = colon < 0 ? undefined : label.slice(colon + 1);
  if (SINGLE_PHASES.has(kind)) return { kind };
  if (!PER_PLUGIN_PHASES.has(kind)) return { kind: OTHER_KIND };
  const nameable = suffix !== undefined && (kind === 'carrier' ? CARRIER_KEYS.includes(suffix) : knownIds.has(suffix));
  return nameable ? { kind, id: suffix } : { kind };
}

function render(tally: Tally): string {
  if (tally.named.size === 0) return `${tally.kind} ${tally.ms}ms`;
  const slowest = [...tally.named.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, NAMED_SLOWEST)
    .map(([id, ms]) => `${tally.kind}:${id} ${ms}ms`);
  return `${tally.kind} ${tally.ms}ms (${slowest.join(', ')})`;
}
