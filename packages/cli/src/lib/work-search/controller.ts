import { MAX_WORK_SEARCH_LIMIT, type WorkKind, WorkKindSchema } from '@ferretry/protocol';
import { resolveBoardProject } from '../board-lanes/lane-request';
import { refuse } from '../tasks/errors';
import type { IWorkSearchGateway, IWorkSearchOutput } from './ports';
import { renderHits, renderNoMatch } from './render';

export interface WorkSearchFlags {
  readonly kind?: string | undefined;
  readonly open?: boolean | undefined;
  readonly project?: string | undefined;
  readonly limit?: string | undefined;
  readonly json?: boolean | undefined;
  readonly session?: string | undefined;
}

export interface WorkSearchDependencies {
  readonly gateway: IWorkSearchGateway;
  readonly output: IWorkSearchOutput;
  readonly binary: string;
  /** `FY_SESSION_ID`: the ferret this process is, when it is one. */
  readonly environmentSessionId: string | undefined;
}

function parseKind(typed: string | undefined): WorkKind | undefined {
  if (typed === undefined) return undefined;
  const parsed = WorkKindSchema.safeParse(typed.trim().toLowerCase());
  return parsed.success ? parsed.data : refuse(`--kind is one of ${WorkKindSchema.options.join(' | ')}`);
}

function parseLimit(typed: string | undefined): number | undefined {
  if (typed === undefined) return undefined;
  const limit = Number(typed.trim());
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WORK_SEARCH_LIMIT) {
    return refuse(`--limit is a whole number from 1 to ${String(MAX_WORK_SEARCH_LIMIT)}`);
  }
  return limit;
}

/** `fy search`: cards and agenda items by what they say, across every project and session. */
export class WorkSearchController {
  constructor(private readonly deps: WorkSearchDependencies) {}

  async search(words: readonly string[], flags: WorkSearchFlags): Promise<void> {
    const query = words.join(' ').trim();
    if (query === '') refuse(`say what to look for: ${this.deps.binary} search <words...>`);
    const kind = parseKind(flags.kind);
    const limit = parseLimit(flags.limit);
    const typedSession = flags.session?.trim();
    const as = typedSession !== undefined && typedSession !== '' ? typedSession : this.deps.environmentSessionId;
    const projectTyped = flags.project?.trim();
    const project =
      projectTyped === undefined || projectTyped === ''
        ? undefined
        : resolveBoardProject(projectTyped, await this.deps.gateway.projects(as)).id;
    const answer = await this.deps.gateway.search(
      {
        q: query,
        ...(kind === undefined ? {} : { kind }),
        open: flags.open === true,
        ...(project === undefined ? {} : { project }),
        ...(limit === undefined ? {} : { limit }),
      },
      as,
    );
    if (flags.json === true) return this.deps.output.success(JSON.stringify(answer, null, 2));
    if (answer.hits.length === 0) return this.deps.output.success(renderNoMatch(query, kind));
    const directory = await this.deps.gateway.sessions();
    const lines = renderHits(answer.hits, { directory, own: as, binary: this.deps.binary });
    const more =
      answer.total > answer.hits.length
        ? [
            `Showing ${String(answer.hits.length)} of ${String(answer.total)}; narrow it with --kind, --open or --project, or raise --limit.`,
          ]
        : [];
    this.deps.output.success([...lines, ...more].join('\n'));
  }
}
