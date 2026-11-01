import {
  type GateOption,
  GateOptionSchema,
  type Lane,
  type LaneSet,
  type LaneSetActionRequest,
  type LaneStage,
  LaneStageSchema,
  type LaneTrigger,
  LaneTriggerSchema,
} from '@ferretry/protocol';
import { refuse } from '../tasks/errors';

export interface WorkflowEditOptions {
  readonly lane?: string;
  readonly gate?: readonly string[];
  readonly auto?: string;
}

const NO_TRIGGERS = 'none';

/** A label as an option id: lowercase words joined by dashes ("Not good" is `not-good`). */
const optionId = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

const outcomeOf = (word: string, spec: string): GateOption['outcome'] => {
  const text = word.trim();
  if (text === 'next') return { kind: 'next' };
  if (text === 'close') return { kind: 'close' };
  if (text === 'reopen') return { kind: 'reopen-with-agenda' };
  if (text.startsWith('lane:') && text.length > 'lane:'.length)
    return { kind: 'lane', laneId: text.slice('lane:'.length) };
  return refuse(`--gate takes "<Label>=<next|close|reopen|lane:<id>>"; got "${spec}"`);
};

/** One `--gate "<Label>=<outcome>"` into the option the owner will be shown. */
export function parseGateOption(spec: string): GateOption {
  const at = spec.lastIndexOf('=');
  const label = spec.slice(0, at).trim();
  if (at < 1 || label === '') refuse(`--gate takes "<Label>=<next|close|reopen|lane:<id>>"; got "${spec}"`);
  const parsed = GateOptionSchema.safeParse({
    id: optionId(label),
    label,
    outcome: outcomeOf(spec.slice(at + 1), spec),
  });
  if (!parsed.success) {
    refuse(`--gate "${spec}" is not usable: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  }
  return parsed.data;
}

/** `--auto a,b` into triggers; `none` means nothing moves a card in and the ferret does it. */
export function parseTriggers(text: string): readonly LaneTrigger[] {
  const words = text
    .split(',')
    .map(word => word.trim())
    .filter(word => word !== '');
  if (words.length === 1 && words[0] === NO_TRIGGERS) return [];
  if (words.length === 0) refuse(`--auto takes triggers, comma separated, or "${NO_TRIGGERS}"`);
  return words.map(word => {
    const parsed = LaneTriggerSchema.safeParse(word);
    return parsed.success
      ? parsed.data
      : refuse(`--auto trigger "${word}" is not one of ${LaneTriggerSchema.options.join(' | ')}`);
  });
}

/** The lane with `stage`, and the two fields that mirror a stage brought into line with it. */
const restaged = (lane: Lane, stage: LaneStage): Lane => {
  const { ownerGate: _gate, enterOn: _enter, ...rest } = lane;
  if (stage.kind === 'gate') {
    const ownerGate = lane.category === 'verify' ? lane.ownerGate : true;
    return {
      ...rest,
      ...(lane.enterOn === undefined ? {} : { enterOn: lane.enterOn }),
      ...(ownerGate === undefined ? {} : { ownerGate }),
      stage,
    };
  }
  return {
    ...rest,
    ...(lane.category === 'closed' && lane.ownerGate !== undefined ? { ownerGate: lane.ownerGate } : {}),
    ...(stage.triggers.length === 0 ? {} : { enterOn: [...stage.triggers] }),
    stage,
  };
};

/**
 * A stage edit against the lane set the caller just read: one lane becomes a gate (`--gate`, 1-3 options) or
 * an automatic step (`--auto`), and every other lane stays as it is. The version is the one read, so a set
 * that changed meanwhile is refused. Whether the stage fits the lane (a closed lane is never a gate) is the
 * daemon's to refuse.
 */
export function buildWorkflowEditRequest(current: LaneSet, options: WorkflowEditOptions): LaneSetActionRequest {
  const gates = options.gate ?? [];
  const laneId = options.lane?.trim() ?? '';
  if (laneId === '') refuse(`say which lane: --lane <id>; lanes: ${current.lanes.map(lane => lane.id).join(', ')}`);
  if (gates.length > 0 && options.auto !== undefined)
    refuse('a lane is a gate or automatic: pass --gate or --auto, not both');
  if (gates.length === 0 && options.auto === undefined) {
    refuse('nothing to edit: pass --gate "<Label>=<outcome>" (up to 3) or --auto <trigger,...>');
  }
  const target = current.lanes.find(lane => lane.id === laneId);
  if (target === undefined) {
    refuse(`${current.projectId} has no lane ${laneId}; lanes: ${current.lanes.map(lane => lane.id).join(', ')}`);
  }
  const candidate =
    options.auto === undefined
      ? { kind: 'gate', options: gates.map(parseGateOption) }
      : { kind: 'auto', triggers: parseTriggers(options.auto) };
  const stage = LaneStageSchema.safeParse(candidate);
  if (!stage.success) {
    refuse(`that stage is not usable: ${stage.error.issues.map(issue => issue.message).join('; ')}`);
  }
  return {
    action: 'edit',
    version: current.version,
    layout: {
      lanes: current.lanes.map(lane => (lane.id === laneId ? restaged(lane, stage.data) : lane)),
      variants: current.variants,
    },
    relocate: {},
  };
}
