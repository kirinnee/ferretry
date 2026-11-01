import {
  type BoardProject,
  type BoardProjectId,
  BoardProjectSchema,
  BoardProjectsResponseSchema,
  BoardSwitchRequestSchema,
  BoardSwitchSchema,
  type IFyApiClient,
  type LaneSetActionRequest,
  LaneSetActionRequestSchema,
  LaneSetChangeResponseSchema,
} from '@ferretry/protocol';
import type { ILaneGateway } from '../../lib/board-lanes/ports';

const lanesPath = (projectId: BoardProjectId): string => `/v1/board/projects/${encodeURIComponent(projectId)}/lanes`;
const switchPath = (projectId: BoardProjectId): string => `/v1/board/projects/${encodeURIComponent(projectId)}/switch`;

/** The board's project and lane routes of the daemon API; the only place the lane commands know about URLs. */
export class FyLaneGateway implements ILaneGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request'>) {}

  async projects() {
    return this.client.request('/v1/board/projects', BoardProjectsResponseSchema);
  }

  async project(projectId: BoardProjectId): Promise<BoardProject> {
    return this.client.request(lanesPath(projectId), BoardProjectSchema);
  }

  async change(projectId: BoardProjectId, request: LaneSetActionRequest) {
    return this.client.request(lanesPath(projectId), LaneSetChangeResponseSchema, {
      method: 'POST',
      body: JSON.stringify(LaneSetActionRequestSchema.parse(request)),
      headers: { 'content-type': 'application/json' },
    });
  }

  async switchOf(projectId: BoardProjectId) {
    return this.client.request(switchPath(projectId), BoardSwitchSchema);
  }

  async setSwitch(projectId: BoardProjectId, on: boolean) {
    return this.client.request(switchPath(projectId), BoardSwitchSchema, {
      method: 'PUT',
      body: JSON.stringify(BoardSwitchRequestSchema.parse({ on })),
      headers: { 'content-type': 'application/json' },
    });
  }
}
