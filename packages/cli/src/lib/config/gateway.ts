import {
  CONFIG_IF_MATCH_HEADER,
  type ConfigConfirmResult,
  ConfigConfirmResultSchema,
  type ConfigFilePutResult,
  ConfigFilePutResultSchema,
  type ConfigFileView,
  ConfigFileViewSchema,
  type ConfigStatusView,
  ConfigStatusViewSchema,
} from '@ferretry/protocol';
import type { ConfigApiClient, IConfigGateway } from './ports.ts';

export const CONFIG_STATUS_PATH = '/v1/config/status';
export const CONFIG_CONFIRM_PATH = '/v1/config/confirm';
export const CONFIG_FILE_PATH = '/v1/config/file';

/** `fy config`'s daemon calls, through the protocol client. */
export class ProtocolConfigGateway implements IConfigGateway {
  constructor(private readonly client: ConfigApiClient) {}

  async status(): Promise<ConfigStatusView> {
    return await this.client.request(CONFIG_STATUS_PATH, ConfigStatusViewSchema);
  }

  async file(path: string): Promise<ConfigFileView> {
    return await this.client.request(`${CONFIG_FILE_PATH}?path=${encodeURIComponent(path)}`, ConfigFileViewSchema);
  }

  async write(path: string, text: string, ifMatch: string | undefined): Promise<ConfigFilePutResult> {
    return await this.client.request(CONFIG_FILE_PATH, ConfigFilePutResultSchema, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(ifMatch === undefined ? {} : { [CONFIG_IF_MATCH_HEADER]: ifMatch }),
      },
      body: JSON.stringify({ path, text }),
    });
  }

  async confirm(path: string, etag: string): Promise<ConfigConfirmResult> {
    return await this.client.request(CONFIG_CONFIRM_PATH, ConfigConfirmResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, etag }),
    });
  }
}
