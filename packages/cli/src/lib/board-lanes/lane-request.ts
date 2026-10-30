import {
  type BoardProject,
  type BoardProjectsResponse,
  type LaneRenames,
  LaneRenamesSchema,
  type LaneSet,
  type LaneSetActionRequest,
  LaneTemplateNameSchema,
} from '@ferretry/protocol';
import { refuse } from '../tasks/errors';

export interface LaneProposeOptions {
  readonly template?: string;
  readonly rename?: readonly string[];
}

export interface LaneEditOptions {
  readonly rename?: readonly string[];
  readonly remove?: readonly string[];
  readonly into?: string;
}

/** `old=new` pairs into the renames a proposal or an edit applies, by lane id. */
export function parseRenames(pairs: readonly string[]): LaneRenames {
  const entries = pairs.map(pair => {
    const at = pair.indexOf('=');
    const id = pair.slice(0, at).trim();
    const name = pair.slice(at + 1).trim();
    if (at < 1 || name === '') refuse(`--rename takes old=new, with the lane id on the left; got "${pair}"`);
    return [id, name] as const;
  });
  const parsed = LaneRenamesSchema.safeParse(Object.fromEntries(entries));
  if (!parsed.success) {
    refuse(`--rename is not usable: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  }
  if (new Set(entries.map(([id]) => id)).size !== entries.length) refuse('--rename names a lane more than once');
  return parsed.data;
}

export function buildProposeRequest(options: LaneProposeOptions): LaneSetActionRequest {
  const template = LaneTemplateNameSchema.safeParse(options.template);
  if (!template.success) refuse(`--template is one of ${LaneTemplateNameSchema.options.join(' | ')}`);
  return { action: 'propose', template: template.data, renames: parseRenames(options.rename ?? []) };
}

/**
 * An edit against the lane set the caller just read: renames keep the lane's id, a removed lane drops out
 * of every variant and its cards go to `--into`. Anything the layout cannot hold is the daemon's to refuse.
 */
export function buildEditRequest(current: LaneSet, options: LaneEditOptions): LaneSetActionRequest {
  const renames = parseRenames(options.rename ?? []);
  const removed = new Set(options.remove ?? []);
  const known = new Set(current.lanes.map(lane => lane.id));
  const missing = [...Object.keys(renames), ...removed].filter(id => !known.has(id));
  if (missing.length > 0)
    refuse(`${current.projectId} has no lane ${missing.join(', ')}; lanes: ${[...known].join(', ')}`);
  if (Object.keys(renames).length === 0 && removed.size === 0)
    refuse('nothing to edit: pass --rename old=new or --remove <lane>');
  const renamedAndRemoved = Object.keys(renames).filter(id => removed.has(id));
  if (renamedAndRemoved.length > 0) refuse(`${renamedAndRemoved.join(', ')} is both renamed and removed`);
  if (removed.size > 0 && options.into === undefined) {
    refuse(`say where the cards of ${[...removed].join(', ')} go: --into <lane>`);
  }
  if (removed.size === 0 && options.into !== undefined) refuse('--into only goes with --remove');
  const into = options.into;
  if (into !== undefined && (!known.has(into) || removed.has(into))) {
    refuse(`--into must be a lane that stays: ${[...known].filter(id => !removed.has(id)).join(', ')}`);
  }
  const lanes = current.lanes
    .filter(lane => !removed.has(lane.id))
    .map(lane => ({ ...lane, name: renames[lane.id] ?? lane.name }));
  const variants = Object.fromEntries(
    Object.entries(current.variants).map(([workflow, ids]) => [workflow, (ids ?? []).filter(id => !removed.has(id))]),
  );
  return {
    action: 'edit',
    version: current.version,
    layout: { lanes, variants: Object.fromEntries(Object.entries(variants).filter(([, ids]) => ids.length > 0)) },
    relocate: Object.fromEntries([...removed].map(id => [id, into ?? ''])),
  };
}

/**
 * Which board a command means: the one named by `--project` (its id or its name), else the board of the
 * calling session. A caller with neither is told what to pass.
 */
export function resolveBoardProject(requested: string | undefined, listing: BoardProjectsResponse): BoardProject {
  const wanted = requested?.trim();
  if (wanted !== undefined && wanted !== '') {
    const folded = wanted.toLowerCase();
    const found =
      listing.projects.find(project => project.id === wanted) ??
      listing.projects.find(project => project.name.toLowerCase() === folded);
    return (
      found ?? refuse(`no project "${wanted}"; boards: ${listing.projects.map(project => project.name).join(', ')}`)
    );
  }
  const current = listing.projects.find(project => project.id === listing.current);
  return (
    current ??
    refuse(`say which project: --project <name>; boards: ${listing.projects.map(project => project.name).join(', ')}`)
  );
}
