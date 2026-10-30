import type { BoardProject } from '@ferretry/protocol';
import { refuse } from '../tasks/errors';
import { renderBoardLanes, renderLaneChange } from './lane-render';
import {
  buildEditRequest,
  buildProposeRequest,
  type LaneEditOptions,
  type LaneProposeOptions,
  resolveBoardProject,
} from './lane-request';
import type { ILaneGateway, ILaneOutput } from './ports';

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

export interface LaneTarget {
  readonly project?: string;
  readonly json: boolean;
}

/** `fy board lanes propose|show|edit` — each reads the board list once to find the project, then acts. */
export class LaneController {
  constructor(
    private readonly gateway: ILaneGateway,
    private readonly output: ILaneOutput,
    private readonly binary: string,
  ) {}

  private async target(project: string | undefined): Promise<BoardProject> {
    return resolveBoardProject(project, await this.gateway.projects());
  }

  async propose(target: LaneTarget, options: LaneProposeOptions): Promise<void> {
    const request = buildProposeRequest(options);
    const board = await this.target(target.project);
    const change = await this.gateway.change(board.id, request);
    this.output.success(target.json ? asJson(change) : renderLaneChange(change, board.name));
  }

  async show(target: LaneTarget): Promise<void> {
    const project = await this.gateway.project((await this.target(target.project)).id);
    this.output.success(target.json ? asJson(project) : renderBoardLanes(project, this.binary));
  }

  async edit(target: LaneTarget, options: LaneEditOptions): Promise<void> {
    const board = await this.target(target.project);
    const { laneSet } = await this.gateway.project(board.id);
    if (laneSet === null) {
      refuse(
        `${board.name} has no lanes to edit; propose them first: ${this.binary} board lanes propose --template <template> --project ${board.name}`,
      );
    }
    const change = await this.gateway.change(board.id, buildEditRequest(laneSet, options));
    this.output.success(target.json ? asJson(change) : renderLaneChange(change, board.name));
  }
}
