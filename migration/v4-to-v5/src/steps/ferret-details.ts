/**
 * The second half of the Ferrets step: the documents v5 keeps BESIDE each `ferret.json`.
 *
 * | v4                                    | v5 (`packages/core/ferrets/daemon/lib/state.ts`)                       |
 * | ------------------------------------- | ---------------------------------------------------------------------- |
 * | `state/sessions/<sid>/config.json`    | `state/ferrets/<sid>/config.json`  `SessionConfigSchema` (strict)      |
 * | `state/sessions/<sid>/state.json`     | `state/ferrets/<sid>/state.json`   `SessionStateSchema` (strict)       |
 * | `state/sessions/<sid>/pins.json`      | `state/ferrets/<sid>/pins.json`    `{pins: PinSchema[]}` (strict)      |
 * | (config.json start facts and name)    | `state/ferrets/<sid>/details.json` `{options?, title?}` (strict)       |
 * | `state/agent-pins.json`               | `state/ferrets/agent-pins.json`    `AgentPinFileSchema` (strict)       |
 *
 * Those v5 schemas are private to the Ferrets daemon, and this tool imports product code only through a contract,
 * so the documents are built from this mapping and `tests/unit/ferret-details.test.ts` reads every one back with
 * v5's REAL schemas in a subprocess. `details.json` alone is checked here, against `StartOptionsSchema` and
 * `FerretTitleSchema`, which ARE in the contract.
 *
 * The declared v4 → v5 session fields differ only in `migration`/`migrations`, renamed `move`/`moves`. The
 * Ferrets contract exports these documents STRICT (lead decision), so only the keys v5's schemas declare are written
 * ({@link SESSION_CONFIG_KEYS}, {@link SESSION_STATE_KEYS}; the test pins both lists to v5's real schemas). Every v4
 * key left out (lifecycle `command`, `prompt`, `tmuxSession`, `sessionCapabilityHash`, internal queue payloads and
 * filesystem proofs) is reported BY NAME in the step's `notCarried`. Paths into the old home are rewritten to the
 * new one: the runtime wrapper (`agent`), the transcript (the same pointer `ferret.json` got, or none) and a
 * conversion's `fromFile` in the shared pool.
 *
 * `environment.json` (a plaintext credential) is never opened.
 */
import { FerretTitleSchema, StartOptionsSchema, type TranscriptProvenance } from '@ferretry/core-ferrets/contract';
import { isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import type { KeptItem, NotCarried } from '../report.ts';
import { agentHomesRoot, inside } from '../v5/harness-paths.ts';
import { info, json, type V4Config } from '../v4/ferrets.ts';
import { MAX_AGENT_PINS, V4AgentPin, V4AgentPinFile, V4Pin, V4PinSnapshot } from '../v4/pins.ts';
import type { StepContext } from './index.ts';

/** One converted ferret, as the record half of the step decided it. */
export interface DetailsSource {
  readonly config: V4Config;
  /** The runtime name `ferret.json` carries (the current name when v4 recorded a former one). */
  readonly runtime: string;
  /** The transcript pointer `ferret.json` carries; `undefined` when it carries none. */
  readonly transcript: TranscriptProvenance | undefined;
}

type Json = Record<string, unknown>;

const Document = z.record(z.string(), z.unknown());
/** v5's kernel stamps `format` first; the body schemas below mirror v5's own declarations. */
const Stamp = { format: z.literal(1) };
const SessionDocument = z.looseObject({ ...Stamp, id: z.string().min(1) });

/** Every key v5's `SessionConfigSchema` declares (`packages/core/ferrets/daemon/lib/protocol/session.ts`). */
export const SESSION_CONFIG_KEYS = [
  'id',
  'incarnation',
  'runtimeGeneration',
  'name',
  'nameSource',
  'teammate',
  'label',
  'parent',
  'credentialRevoked',
  'projectId',
  'focusTask',
  'focusAnchor',
  'boardSkip',
  'provenance',
  'agent',
  'harness',
  'modelHint',
  'model',
  'launchReasoningEffort',
  'launchFast',
  'launchSettings',
  'mode',
  'remoteControl',
  'harnessFlags',
  'cwd',
  'createdAt',
  'updatedAt',
  'turn',
  'intervalSeconds',
  'timeoutSeconds',
  'nudgeAfterSeconds',
  'killAfterSeconds',
  'directSendMaxChars',
  'resumeMenuChoice',
  'maxSnapshots',
  'move',
  'moves',
  'transferredFrom',
  'conversion',
  'transcript',
  'retry',
  'hypermedia',
  'pack',
  'agenda',
  'compactAt',
] as const;

/** Every key v5's `SessionStateSchema` declares (same file). */
export const SESSION_STATE_KEYS = [
  'id',
  'status',
  'turn',
  'pid',
  'startedAt',
  'finishedAt',
  'lastActivityAt',
  'lastSnapshotAt',
  'lastDiffAt',
  'exitCode',
  'reason',
  'health',
  'promptReady',
  'remoteControlUrl',
  'openTools',
  'pendingQuestion',
  'lastAnsweredQuestionToolUseId',
  'lastTranscriptAt',
  'lastPaneAt',
  'lastCounterAdvanceAt',
  'lastTokenAdvanceAt',
  'lastSubprocessAt',
  'subprocessSince',
  'nudgedAt',
  'needsHuman',
  'needsHumanKind',
  'agenda',
  'contextPercent',
  'contextTokens',
  'contextAt',
  'contextWindow',
  'usage5hPercent',
  'usageWeeklyPercent',
  'usage5hResetAt',
  'usageWeeklyResetAt',
  'usageAtLimit',
  'usageAuthOk',
  'launchedAt',
  'harnessStartupMs',
  'harnessNotReadyAfterMs',
  'launchInstructions',
  'observedModel',
  'observedModelAt',
  'observedReasoningEffort',
  'observedFast',
  'activity',
  'lastToolStartedAt',
  'quota',
  'retryAttempt',
  'turnCompleted',
  'turnState',
  'turnStateAt',
  'turnPrompt',
  'permissionRequest',
  'harnessDialog',
  'waiting',
  'waitingCreditSeconds',
] as const;

/** A key name safe to print in the report (a schema field name); anything else is only counted. */
const NAMEABLE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** `format` first, then the declared keys in the v4 document's order; the rest are returned by name. */
function declaredOnly(document: Json, keys: readonly string[]): { readonly kept: Json; readonly dropped: string[] } {
  const declared = new Set(keys);
  const kept: Json = { format: 1 };
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(document)) {
    if (key === 'format') continue;
    if (declared.has(key)) kept[key] = value;
    else dropped.push(key);
  }
  return { kept, dropped };
}
const PinsDocument = z.strictObject({ ...Stamp, pins: z.array(V4Pin) });
const AgentPinsDocument = z.strictObject({ ...Stamp, pins: z.array(V4AgentPin).max(MAX_AGENT_PINS) });
const StartOptions = StartOptionsSchema.omit({ title: true });
const DetailsDocument = z.strictObject({
  ...Stamp,
  options: StartOptions.optional(),
  title: FerretTitleSchema.optional(),
});

const file = <Shape>(path: string, schema: z.ZodType<Shape>) => ({ path, format: 1, schema, mode: 0o600 });

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A wrapper path inside the v4 `fleet/bin`, moved to the same runtime's wrapper in the new home. */
function wrapper(ctx: StepContext, runtime: string, value: unknown): unknown {
  if (typeof value !== 'string' || !isAbsolute(value)) return value;
  const name = inside(join(ctx.v4.fleet, 'bin'), value);
  return name === undefined || name.length === 0 || name.includes(sep)
    ? value
    : ctx.v5.resolve(join('fleet/bin', runtime));
}

/** A cross-harness conversion's source transcript, when it lives in the copied shared pool. */
function conversion(ctx: StepContext, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Json;
  const harness = record.fromHarness;
  const from = text(record.fromFile);
  if ((harness !== 'claude' && harness !== 'codex') || from === undefined) return value;
  const pooled = inside(join(ctx.v4.fleet, 'shared', harness), from);
  return pooled === undefined || pooled.length === 0
    ? value
    : { ...record, fromFile: ctx.v5.resolve(join(agentHomesRoot(harness), '_shared', pooled)) };
}

/**
 * `config.json`: the v4 document's declared keys, `format` first, the two renamed keys moved and old-home paths
 * rewritten. A transcript `ferret.json` could not carry is not carried here either.
 */
export function sessionConfigDocument(ctx: StepContext, source: DetailsSource, raw: Json) {
  const { migration, migrations, transcript: _transcript, ...rest } = raw;
  const isName = typeof rest.agent === 'string' && !isAbsolute(rest.agent);
  const renamed: Json = {
    ...rest,
    ...(rest.agent === undefined ? {} : { agent: isName ? source.runtime : wrapper(ctx, source.runtime, rest.agent) }),
    ...(source.transcript === undefined ? {} : { transcript: source.transcript }),
    ...(rest.conversion === undefined ? {} : { conversion: conversion(ctx, rest.conversion) }),
    ...(migration === undefined ? {} : { move: migration }),
    ...(migrations === undefined ? {} : { moves: migrations }),
  };
  return declaredOnly(renamed, SESSION_CONFIG_KEYS);
}

/** `state.json`: the v4 document's declared keys, `format` first; its status is the one `ferret.json`'s state came from. */
export function sessionStateDocument(raw: Json) {
  return declaredOnly(raw, SESSION_STATE_KEYS);
}

/** The card a v4 session was anchored to (or last touched), when it is a card on this machine. */
function card(raw: Json): unknown {
  for (const key of ['focusAnchor', 'focusTask']) {
    const ref = raw[key];
    if (ref !== null && typeof ref === 'object' && !Array.isArray(ref)) {
      const { id, machineId } = ref as Json;
      if (machineId === undefined && id !== undefined) return id;
    }
  }
  return undefined;
}

/**
 * `details.json`: the start facts v4 kept in `config.json`, as `StartOptionsSchema` names them, and the session's
 * free-form name as its title. A value the v5 option refuses is left out (it stays in `config.json`).
 */
export function detailsDocument(raw: Json): Json | undefined {
  const candidates: Record<string, unknown> = {
    label: raw.label,
    card: card(raw),
    model: raw.model,
    effort: raw.launchReasoningEffort,
    fast: raw.launchFast,
    mode: raw.mode,
    intervalSeconds: raw.intervalSeconds,
    timeoutSeconds: raw.timeoutSeconds,
    nudgeAfterSeconds: raw.nudgeAfterSeconds,
    killAfterSeconds: raw.killAfterSeconds,
    directSendMaxChars: raw.directSendMaxChars,
    resumeMenuChoice: raw.resumeMenuChoice,
    maxSnapshots: raw.maxSnapshots,
    harnessFlags: raw.harnessFlags,
    remoteControl: raw.remoteControl,
  };
  const shape = StartOptions.shape as Record<string, z.ZodType>;
  const options: Json = {};
  for (const [key, value] of Object.entries(candidates)) {
    if (value === undefined) continue;
    const parsed = shape[key]?.safeParse(value);
    if (parsed?.success === true && parsed.data !== undefined) options[key] = parsed.data;
  }
  // v4's `name` is the session's title (`nameSource`); the callsign is `teammate`. A session older than
  // `nameSource` named `interactive` carries the placeholder, not a title.
  const name = text(raw.name);
  const placeholder = raw.nameSource === undefined && name === 'interactive';
  const title = placeholder ? undefined : FerretTitleSchema.safeParse(name).data;
  if (Object.keys(options).length === 0 && title === undefined) return undefined;
  return {
    format: 1,
    ...(Object.keys(options).length === 0 ? {} : { options }),
    ...(title === undefined ? {} : { title }),
  };
}

/** A pin file v4 itself would have shown: v4 read a damaged or foreign one as no pins, so it is skipped here too. */
async function readTolerant(path: string): Promise<unknown> {
  const facts = await info(path);
  if (facts === undefined) return undefined;
  if (!facts.isFile()) throw new Error('v4 pin document is not a regular file');
  try {
    return await json(path, z.unknown());
  } catch {
    return null;
  }
}

/** Validate every document before any write; errors are redacted by the owning step. */
export async function prepareDetails(ctx: StepContext, sources: readonly DetailsSource[]) {
  const writes: (() => Promise<void>)[] = [];
  const counts = { configs: 0, states: 0, details: 0, pinFiles: 0, pins: 0, unreadablePins: 0, agentPins: 0 };
  const ids = new Set<string>();
  const dropped = { config: new Set<string>(), state: new Set<string>(), unnamed: 0 };
  const note = (into: Set<string>, keys: readonly string[]) => {
    for (const key of keys) {
      if (NAMEABLE.test(key)) into.add(key);
      else dropped.unnamed += 1;
    }
  };
  for (const source of sources) {
    const id = source.config.id;
    ids.add(id);
    const folder = join(ctx.v4.sessions, id);
    const target = (name: string) => join('state/ferrets', id, name);

    const raw = await json(join(folder, 'config.json'), Document);
    if (raw === undefined) throw new Error('v4 session config vanished');
    const converted = sessionConfigDocument(ctx, source, raw);
    note(dropped.config, converted.dropped);
    const config = SessionDocument.parse(converted.kept);
    writes.push(() => ctx.v5.json(file(target('config.json'), SessionDocument), config));
    counts.configs += 1;

    const state = await json(join(folder, 'state.json'), Document);
    if (state !== undefined) {
      const converted = sessionStateDocument(state);
      note(dropped.state, converted.dropped);
      const document = SessionDocument.parse(converted.kept);
      if (document.id !== id) throw new Error('v4 state identity mismatch');
      writes.push(() => ctx.v5.json(file(target('state.json'), SessionDocument), document));
      counts.states += 1;
    }

    const details = detailsDocument(raw);
    if (details !== undefined) {
      const document = DetailsDocument.parse(details);
      writes.push(() => ctx.v5.json(file(target('details.json'), DetailsDocument), document));
      counts.details += 1;
    }

    const pins = await readTolerant(join(folder, 'pins.json'));
    if (pins !== undefined) {
      const snapshot = V4PinSnapshot.safeParse(pins);
      if (!snapshot.success || snapshot.data.sessionId !== id) counts.unreadablePins += 1;
      else {
        const document = PinsDocument.parse({ format: 1, pins: snapshot.data.pins });
        writes.push(() => ctx.v5.json(file(target('pins.json'), PinsDocument), document));
        counts.pinFiles += 1;
        counts.pins += document.pins.length;
      }
    }
  }

  const agentPins = await readTolerant(join(ctx.v4.state, 'agent-pins.json'));
  if (agentPins !== undefined) {
    const parsed = V4AgentPinFile.safeParse(agentPins);
    if (!parsed.success) counts.unreadablePins += 1;
    else {
      // A pin naming a session with no config.json names no ferret in the new home.
      const pins = parsed.data.pins.filter(pin => ids.has(pin.sessionId)).slice(0, MAX_AGENT_PINS);
      const document = AgentPinsDocument.parse({ format: 1, pins });
      writes.push(() => ctx.v5.json(file('state/ferrets/agent-pins.json', AgentPinsDocument), document));
      counts.agentPins = pins.length;
    }
  }

  const kept: KeptItem[] = [
    { what: 'session config documents', count: counts.configs },
    { what: 'session state documents', count: counts.states },
    { what: 'start options and titles (details.json)', count: counts.details },
    { what: 'note and message pins', count: counts.pins },
    { what: 'pinned ferrets', count: counts.agentPins },
  ];
  if (counts.unreadablePins > 0)
    kept.push({ what: 'damaged pin files read as no pins, as v4 read them', count: counts.unreadablePins });
  // Names only, never a value: which v4 keys this home held that v5's strict documents do not declare.
  const notCarried: NotCarried[] = [];
  const named = (keys: Set<string>) => [...keys].sort().join(', ');
  if (dropped.config.size > 0)
    notCarried.push({
      what: `config.json keys found in this home: ${named(dropped.config)}`,
      why: 'v5 SessionConfigSchema does not declare them and the Ferrets contract document is strict',
    });
  if (dropped.state.size > 0)
    notCarried.push({
      what: `state.json keys found in this home: ${named(dropped.state)}`,
      why: 'v5 SessionStateSchema does not declare them (v4 internal queue payloads and filesystem proofs) and the Ferrets contract document is strict',
    });
  if (dropped.unnamed > 0)
    notCarried.push({
      what: `${dropped.unnamed} config/state keys whose names are not field names`,
      why: 'undeclared by v5; not printed, since a non-field key may be data',
    });
  return {
    kept,
    notCarried,
    async write() {
      for (const write of writes) await write();
    },
  };
}
