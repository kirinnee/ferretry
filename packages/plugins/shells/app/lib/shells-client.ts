/** Shells' routes by key, each answer parsed against the contract's schema; nothing else talks to the daemon. */
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  NixFactsSchema,
  type NixFacts,
  ShellAddedSchema,
  type ShellAdded,
  type ShellAddRequest,
  ShellBuildResultSchema,
  type ShellBuildResult,
  ShellDetailSchema,
  type ShellDetail,
  ShellListSchema,
  type ShellName,
  ShellPreviewSchema,
  type ShellPreview,
  ShellRemovedSchema,
  type ShellSummary,
} from '../../contract/index.ts';

export interface ShellsClient {
  list(): Promise<readonly ShellSummary[]>;
  nix(): Promise<NixFacts>;
  detail(name: ShellName): Promise<ShellDetail>;
  preview(request: ShellAddRequest): Promise<ShellPreview>;
  add(request: ShellAddRequest): Promise<ShellAdded>;
  relock(name: ShellName, expectedHash: string): Promise<ShellPreview>;
  build(name: ShellName): Promise<ShellBuildResult>;
  remove(name: ShellName): Promise<void>;
}

export function shellsClient(client: PluginClient): ShellsClient {
  return {
    list: async () => ShellListSchema.parse(await client.call('GET /v1/shells')).shells,
    detail: async name => ShellDetailSchema.parse(await client.call('GET /v1/shells/:name', { params: { name } })),
    nix: async () => NixFactsSchema.parse(await client.call('GET /v1/shells/nix')),
    preview: async request => ShellPreviewSchema.parse(await client.call('POST /v1/shells/preview', { body: request })),
    add: async request => ShellAddedSchema.parse(await client.call('POST /v1/shells', { body: request })),
    relock: async (name, expectedHash) =>
      ShellPreviewSchema.parse(
        await client.call('POST /v1/shells/:name/relock', { params: { name }, body: { expectedHash } }),
      ),
    build: async name =>
      ShellBuildResultSchema.parse(await client.call('POST /v1/shells/:name/build', { params: { name } })),
    remove: async name => {
      ShellRemovedSchema.parse(await client.call('DELETE /v1/shells/:name', { params: { name } }));
    },
  };
}
