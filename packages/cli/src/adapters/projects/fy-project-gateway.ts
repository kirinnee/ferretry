import {
  type IFyApiClient,
  ProjectInfoSchema,
  ProjectListSchema,
  type RegisterProjectRequest,
  RegisterProjectRequestSchema,
} from '@ferretry/protocol';
import type { IProjectGateway } from '../../lib/projects/ports';

/** The project registry routes of the daemon API; the only place `fy project` knows about URLs. */
export class FyProjectGateway implements IProjectGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request'>) {}

  async projects() {
    return await this.client.request('/v1/projects', ProjectListSchema);
  }

  async register(request: RegisterProjectRequest) {
    return await this.client.request('/v1/projects', ProjectInfoSchema, {
      method: 'POST',
      body: JSON.stringify(RegisterProjectRequestSchema.parse(request)),
      headers: { 'content-type': 'application/json' },
    });
  }
}
