import { expect, test } from 'bun:test';
import type { ApiRequest, CallContext } from '@ferretry/kernel/contract';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import daemon from '../../daemon/index.ts';
import manifest from '../../manifest.ts';

test('G177 the daemon refuses project preview and add without a registered-project/worktree contract', async () => {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app' });
  let opened = 0;
  const half = daemon.build?.({
    manifest,
    needs: { ferrets, vault: new FakeVault(), sealed: new FakeSealedDocuments() },
    uses: {
      claudeCode: { current: () => undefined },
      codex: { current: () => undefined },
      projects: { current: () => undefined },
    },
    hooks: {} as never,
    kernel: {
      config: { collection: () => new Map() },
      roots: {
        root: () => {
          opened += 1;
          throw new Error('must not open a project file');
        },
      },
    } as unknown as DaemonContext<typeof manifest>['kernel'],
  } as DaemonContext<typeof manifest>);
  const body = { name: 'acme', server: { transport: 'command', command: 'tool', args: [], env: {} }, etag: null };
  for (const suffix of ['project/preview', 'project']) {
    const { etag: _etag, ...preview } = body;
    const call = {
      params: new Map([['ferretId', 'f1']]),
      request: {
        text: async () => JSON.stringify(suffix.endsWith('/preview') ? preview : body),
      } as ApiRequest,
    } as CallContext;
    const route =
      half?.routes?.[`POST /v1/ferrets/:ferretId/mcp/${suffix}` as keyof NonNullable<typeof half>['routes']];
    expect(route).toBeDefined();
    if (route === undefined) throw new Error('missing MCP project route');
    await expect(route(call)).rejects.toMatchObject({ status: 409, code: 'mcp_project_unavailable' });
  }
  expect(opened).toBe(0);
});
