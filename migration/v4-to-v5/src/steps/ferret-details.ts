/**
 * The second half of the Ferrets step: the documents v5 keeps BESIDE each `ferret.json`.
 *
 * | v4                                    | v5 (`@ferretry/core-ferrets/contract`, every body STRICT)            |
 * | ------------------------------------- | -------------------------------------------------------------------- |
 * | `state/sessions/<sid>/config.json`    | `state/ferrets/<sid>/config.json`  `FerretConfigDocumentSchema`     |
 * | `state/sessions/<sid>/state.json`     | `state/ferrets/<sid>/state.json`   `FerretStateDocumentSchema`      |
 * | `state/sessions/<sid>/pins.json`      | `state/ferrets/<sid>/pins.json`    `FerretPinsDocumentSchema`       |
 * | (config.json start facts and name)    | `state/ferrets/<sid>/details.json` `FerretDetailsSchema`            |
 * | `state/agent-pins.json`               | `state/ferrets/agent-pins.json`    `AgentPinsDocumentSchema`        |
 *
 * Every body is parsed with the contract's own strict schema before it is written, `format: 1` first. The v5 key lists
 * are final (gustavo, 2026-11-07): `migration`/`migrations` are renamed `move`/`moves`, `sessionCapabilityHash` is
 * renamed `capabilityHash` and kept only for a ferret that is neither stopped nor cut off (v5 keeps the hash of the
 * CURRENT pane's credential), the lifecycle keys `command`, `prompt` and `tmuxSession` are kept, a state document's old
 * `attention` key and its cleared (`null`) values are dropped, and any other key v5 does not list is dropped and named in
 * the report (never its value): a strict v5 file with an unlisted key reads as damaged.
 * Paths into the old home are rewritten to the new one: the runtime wrapper (`agent`, `command[0]`), the transcript
 * (the same pointer `ferret.json` got, or none) and a conversion's `fromFile` in the shared pool.
 *
 * `environment.json` (a plaintext credential) is never opened.
 */
import {
  AgentPinsDocumentSchema,
  FerretConfigDocumentSchema,
  FerretDetailsSchema,
  FerretPinsDocumentSchema,
  FerretStateDocumentSchema,
  FerretTitleSchema,
  StartOptionsSchema,
  type TranscriptProvenance,
} from '@ferretry/core-ferrets/contract';
import { isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import type { KeptItem } from '../report.ts';
import { agentHomesRoot, inside, previewFolder } from '../v5/harness-paths.ts';
import { info, json, type V4Config } from '../v4/ferrets.ts';
import { MAX_AGENT_PINS, V4AgentPinFile, V4PinSnapshot } from '../v4/pins.ts';
import { rebaseV4Path } from '../v4/rebase.ts';
import type { StepContext } from './index.ts';

/** One converted ferret, as the record half of the step decided it. */
export interface DetailsSource {
  readonly config: V4Config;
  /** The runtime name `ferret.json` carries (the current name when v4 recorded a former one). */
  readonly runtime: string;
  /** The transcript pointer `ferret.json` carries; `undefined` when it carries none. */
  readonly transcript: TranscriptProvenance | undefined;
  /** v4 last saw it finished (or never started): v5 keeps no credential hash for it. */
  readonly stopped: boolean;
}

type Json = Record<string, unknown>;

const Document = z.record(z.string(), z.unknown());
/** The kernel stamps `format` first; the contract's bodies describe the document without it. */
const Stamp = { format: z.literal(1) };
const ConfigDocument = FerretConfigDocumentSchema.extend(Stamp);
const StateDocument = FerretStateDocumentSchema.extend(Stamp);
const PinsDocument = FerretPinsDocumentSchema.extend(Stamp);
const AgentPinsDocument = AgentPinsDocumentSchema.extend(Stamp);
const DetailsDocument = FerretDetailsSchema.extend(Stamp);
const StartOptions = StartOptionsSchema.omit({ title: true });
const CONFIG_KEYS = new Set(Object.keys(FerretConfigDocumentSchema.shape));
const STATE_KEYS = new Set(Object.keys(FerretStateDocumentSchema.shape));

/** `body` with only the keys v5 lists; each other key's NAME goes into `dropped`. */
function listedOnly(body: Json, listed: ReadonlySet<string>, dropped: Set<string>): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(body))
    if (listed.has(key)) out[key] = value;
    else dropped.add(key);
  return out;
}

const file = <Shape>(path: string, schema: z.ZodType<Shape>) => ({ path, format: 1, schema, mode: 0o600 });

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A wrapper path inside the v4 `fleet/bin`, moved to the same runtime's wrapper in the new home. */
function wrapper(ctx: StepContext, runtime: string, value: unknown): unknown {
  if (typeof value !== 'string' || !isAbsolute(value)) return value;
  const name = inside(join(ctx.v4.fleet, 'bin'), rebaseV4Path(ctx.v4.home, value));
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
  const pooled = inside(join(ctx.v4.fleet, 'shared', harness), rebaseV4Path(ctx.v4.home, from));
  return pooled === undefined || pooled.length === 0
    ? value
    : { ...record, fromFile: ctx.v5.resolve(join(agentHomesRoot(harness), '_shared', pooled)) };
}

/**
 * `config.json`: the v4 document, `format` first, the renamed keys moved, old-home paths rewritten and every key v5 does
 * not list left out (its name added to `dropped`).
 */
export function sessionConfigDocument(
  ctx: StepContext,
  source: DetailsSource,
  raw: Json,
  dropped: Set<string> = new Set(),
): Json {
  const {
    format: _format,
    migration,
    migrations,
    transcript: _transcript,
    agent,
    command,
    sessionCapabilityHash,
    ...rest
  } = raw;
  const preview = ctx.preview === true;
  const isName = (typeof agent === 'string' && !isAbsolute(agent)) || preview;
  const keepHash = !preview && !source.stopped && raw.credentialRevoked !== true && sessionCapabilityHash !== undefined;
  // The preview launches nothing from v4: no command, no pane address, no conversion, no live move or transfer plan.
  const { tmuxSession: _tmux, conversion: _conversion, ...previewRest } = rest;
  const kept = preview ? previewRest : rest;
  const body: Json = {
    ...kept,
    agent: isName ? source.runtime : wrapper(ctx, source.runtime, agent),
    ...(preview ? { cwd: previewFolder(ctx, source.config.cwd) } : {}),
    ...(command === undefined || preview
      ? {}
      : {
          command: Array.isArray(command)
            ? command.map((part, index) => (index === 0 ? wrapper(ctx, source.runtime, part) : part))
            : command,
        }),
    ...(source.transcript === undefined ? {} : { transcript: source.transcript }),
    ...(kept.conversion === undefined ? {} : { conversion: conversion(ctx, kept.conversion) }),
    ...(migration === undefined || preview ? {} : { move: migration }),
    ...(migrations === undefined || preview ? {} : { moves: migrations }),
    ...(keepHash ? { capabilityHash: sessionCapabilityHash } : {}),
  };
  return { format: 1, ...listedOnly(body, CONFIG_KEYS, dropped) };
}

/** `state.json`: `format` first, the old `attention` key and cleared (`null`) values left out, then v5's list only. */
export function sessionStateDocument(raw: Json, dropped: Set<string> = new Set(), preview = false): Json {
  const { format: _format, attention: _attention, ...rest } = raw;
  const live = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null));
  // The preview's ferrets are all stopped: no process id, no live-pane facts, no remote-control link.
  const body = preview
    ? Object.fromEntries(
        Object.entries({ ...live, status: 'stopped' }).filter(
          ([key]) =>
            !['pid', 'promptReady', 'remoteControlUrl', 'openTools', 'pendingQuestion', 'health'].includes(key),
        ),
      )
    : live;
  return { format: 1, ...listedOnly(body, STATE_KEYS, dropped) };
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
  const droppedConfig = new Set<string>();
  const droppedState = new Set<string>();
  const ids = new Set<string>();
  for (const source of sources) {
    const id = source.config.id;
    ids.add(id);
    const folder = join(ctx.v4.sessions, id);
    const target = (name: string) => join('state/ferrets', id, name);

    const raw = await json(join(folder, 'config.json'), Document);
    if (raw === undefined) throw new Error('v4 session config vanished');
    const config = ConfigDocument.parse(sessionConfigDocument(ctx, source, raw, droppedConfig));
    writes.push(() => ctx.v5.json(file(target('config.json'), ConfigDocument), config));
    counts.configs += 1;

    const state = await json(join(folder, 'state.json'), Document);
    if (state !== undefined) {
      const document = StateDocument.parse(sessionStateDocument(state, droppedState, ctx.preview === true));
      if (document.id !== id) throw new Error('v4 state identity mismatch');
      writes.push(() => ctx.v5.json(file(target('state.json'), StateDocument), document));
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
  const notCarried = [
    ...(droppedConfig.size === 0
      ? []
      : [
          {
            what: `state/sessions/<sid>/config.json keys: ${[...droppedConfig].sort().join(', ')}`,
            why: 'v5 lists no such key in a ferret’s config.json (its key list is final and strict); values never read into the report',
          },
        ]),
    ...(droppedState.size === 0
      ? []
      : [
          {
            what: `state/sessions/<sid>/state.json keys: ${[...droppedState].sort().join(', ')}`,
            why: 'v5 lists no such key in a ferret’s state.json (its key list is final and strict); values never read into the report',
          },
        ]),
  ];
  return {
    kept,
    notCarried,
    async write() {
      for (const write of writes) await write();
    },
  };
}
