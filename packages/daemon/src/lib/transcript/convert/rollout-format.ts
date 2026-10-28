/**
 * What a Codex rollout looks like, reduced to the part the converter depends on.
 *
 * Codex ships often and the converter is gated to the versions it was measured on ({@link ./versions.ts}).
 * Refusing every release nobody has recorded yet means a person who upgrades Codex loses conversion
 * until a pull request lands. But what the converter really depends on is not the version number, it is
 * the SHAPE of the records it reads and writes. So an untested version is classified by the shape it
 * actually writes: the same shape as the validated one is allowed (and says so), a different or
 * unreadable one is refused with the field that moved.
 *
 * "Same" means every key the converter relies on is still where it was. A key Codex ADDS is not a
 * difference — 0.164 added `content_item_metadata[].provenance` and nothing broke — so this only ever
 * asks whether something the converter needs went missing.
 *
 * Pure: the caller supplies the rollout's text (read from disk, or produced by a probe run).
 */

/** The records a rollout holds, by `type/payload.type`, each with every key path seen in any of them. */
export type RolloutShape = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The key paths the converter relies on, per record kind, as every validated Codex writes them
 * (0.145 through the newest band in `versions.ts`; `tests/unit/transcript/rollout-format.test.ts` proves it
 * against each recorded fixture). An array element is `[]`.
 */
const VALIDATED_ROLLOUT_KEYS: Readonly<Record<string, readonly string[]>> = {
  'session_meta/-': [
    'payload.id',
    'payload.timestamp',
    'payload.cwd',
    'payload.originator',
    'payload.cli_version',
    'payload.source',
    'payload.model_provider',
  ],
  'response_item/message': ['payload.type', 'payload.role', 'payload.content[].type', 'payload.content[].text'],
  'response_item/function_call': ['payload.type', 'payload.name', 'payload.arguments', 'payload.call_id'],
  'response_item/function_call_output': ['payload.type', 'payload.call_id', 'payload.output'],
};

/**
 * Record kinds a rollout must contain at all for its shape to say anything: the thread and a message.
 * The `event_msg` mirrors are deliberately absent: Codex 0.156 stopped writing `user_message` and
 * `agent_message` (it writes `item_completed`), the converter never reads them, and the rollouts it
 * writes still carry them because every measured version resumes them without complaint.
 */
export const REQUIRED_ROLLOUT_KINDS: readonly string[] = ['session_meta/-', 'response_item/message'];

/** Whether a rollout's shape is the one the converter was validated on. */
export type RolloutFormatVerdict =
  | { readonly kind: 'same' }
  | { readonly kind: 'different'; readonly reason: string }
  /** Nobody could look: the probe run failed, so the shape is neither confirmed nor ruled out. */
  | { readonly kind: 'unchecked'; readonly reason: string };

/** What {@link classifyRolloutShape} can decide from a shape alone. */
export type ShapeVerdict = Exclude<RolloutFormatVerdict, { readonly kind: 'unchecked' }>;

const asObject = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Every path to a value, interior nodes included: a tool output is a string in one build and a list in another. */
function keyPaths(value: unknown, prefix: string, into: Set<string>): void {
  into.add(prefix);
  if (Array.isArray(value)) {
    for (const item of value) keyPaths(item, `${prefix}[]`, into);
    return;
  }
  const object = asObject(value);
  if (object === undefined) return;
  for (const [key, item] of Object.entries(object)) keyPaths(item, `${prefix}.${key}`, into);
}

/** The shape of a rollout: every line that parses contributes; a line that does not is skipped. */
export function rolloutShape(text: string): RolloutShape {
  const shape = new Map<string, Set<string>>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const object = asObject(record);
    if (object === undefined || typeof object.type !== 'string') continue;
    const payload = asObject(object.payload);
    const kind = `${object.type}/${typeof payload?.type === 'string' ? payload.type : '-'}`;
    const keys = shape.get(kind) ?? new Set<string>();
    keyPaths(object.payload ?? {}, 'payload', keys);
    shape.set(kind, keys);
  }
  return shape;
}

/**
 * Whether `shape` is the validated format. Every kind in `mustSee` has to be present; every kind that
 * is present has to keep the keys the converter relies on. A kind the converter never uses, and a key
 * it never uses, change nothing.
 */
export function classifyRolloutShape(shape: RolloutShape, mustSee: readonly string[]): ShapeVerdict {
  for (const kind of mustSee)
    if (!shape.has(kind)) return { kind: 'different', reason: `it no longer writes ${kind} records` };
  for (const [kind, required] of Object.entries(VALIDATED_ROLLOUT_KEYS)) {
    const seen = shape.get(kind);
    if (seen === undefined) continue;
    const missing = required.filter(key => !seen.has(key));
    if (missing.length > 0)
      return { kind: 'different', reason: `its ${kind} records no longer carry ${missing.join(', ')}` };
  }
  return { kind: 'same' };
}
