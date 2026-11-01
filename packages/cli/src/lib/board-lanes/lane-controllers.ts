import type { BoardProject } from '@ferretry/protocol';
import { refuse } from '../tasks/errors';
import { renderBoardLanes, renderBoardSwitch, renderLaneChange } from './lane-render';
import {
  buildEditRequest,
  buildProposeRequest,
  type LaneEditOptions,
  type LaneProposeOptions,
  resolveBoardProject,
} from './lane-request';
import type { ILaneGateway, ILaneOutput } from './ports';
import { buildWorkflowEditRequest, type WorkflowEditOptions } from './workflow-request';
import { renderWorkflow } from './workflow-render';

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

  /** `fy board status`: whether the project uses the board (docs/board.md § The board is opt-in). */
  async status(target: LaneTarget): Promise<void> {
    const board = await this.target(target.project);
    const state = await this.gateway.switchOf(board.id);
    this.output.success(target.json ? asJson(state) : renderBoardSwitch(state, board.name, this.binary));
  }

  /** `fy board on|off`: the owner's switch. The daemon refuses a ferret, which must ask the owner first. */
  async turn(target: LaneTarget, on: boolean): Promise<void> {
    const board = await this.target(target.project);
    const state = await this.gateway.setSwitch(board.id, on);
    this.output.success(target.json ? asJson(state) : renderBoardSwitch(state, board.name, this.binary));
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

  /** `fy board workflow show`: each lane as a gate the owner answers or an automatic step. */
  async workflow(target: LaneTarget): Promise<void> {
    const project = await this.gateway.project((await this.target(target.project)).id);
    this.output.success(target.json ? asJson(project) : renderWorkflow(project, this.binary));
  }

  /** `fy board workflow edit`: make one lane a gate or an automatic step, through the lanes edit route. */
  async editWorkflow(target: LaneTarget, options: WorkflowEditOptions): Promise<void> {
    const board = await this.target(target.project);
    const { laneSet } = await this.gateway.project(board.id);
    if (laneSet === null) {
      refuse(
        `${board.name} has no lanes to edit; propose them first: ${this.binary} board lanes propose --template <template> --project ${board.name}`,
      );
    }
    const change = await this.gateway.change(board.id, buildWorkflowEditRequest(laneSet, options));
    this.output.success(target.json ? asJson(change) : renderLaneChange(change, board.name));
  }
}
