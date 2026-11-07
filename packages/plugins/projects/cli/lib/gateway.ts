import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ProjectInfo, ProjectList, RegisterProjectRequest } from '../../contract/index.ts';
import type { ProjectGateway } from './project-controller.ts';

/** The project registry routes of the daemon API; the only place `fy project` knows a route key. */
export class ClientProjectGateway implements ProjectGateway {
  constructor(private readonly client: PluginClient) {}

  async projects() {
    return await this.client.call<ProjectList>('GET /v1/projects');
  }

  async register(request: RegisterProjectRequest) {
    return await this.client.call<ProjectInfo>('POST /v1/projects', { body: request });
  }

  async remove(id: string) {
    return await this.client.call<ProjectInfo>('DELETE /v1/projects/:id', { params: { id } });
  }
}
