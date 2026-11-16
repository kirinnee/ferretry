import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  ProjectInfoSchema,
  ProjectListSchema,
  type RegisterProjectRequest,
  RegisterProjectRequestSchema,
} from '../../contract/index.ts';
import type { ProjectGateway } from './project-controller.ts';

/**
 * The project registry routes of the daemon API; the only place `fy project` knows a route key. Requests and answers
 * are parsed with the contract's schemas, as today's gateway did, so a daemon that answers otherwise is an error.
 */
export class ClientProjectGateway implements ProjectGateway {
  constructor(private readonly client: PluginClient) {}

  async projects() {
    return ProjectListSchema.parse(await this.client.call<unknown>('GET /v1/projects'));
  }

  async register(request: RegisterProjectRequest) {
    return ProjectInfoSchema.parse(
      await this.client.call<unknown>('POST /v1/projects', { body: RegisterProjectRequestSchema.parse(request) }),
    );
  }

  async remove(id: string) {
    return ProjectInfoSchema.parse(await this.client.call<unknown>('DELETE /v1/projects/:id', { params: { id } }));
  }
}
