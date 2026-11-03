import { describe, it } from 'bun:test';
import should from 'should';
import { LocalMcpRefusalError } from '../../../src/lib/local-mcp-installs/ports.ts';
import {
  EMPTY_LOCAL_MCP_INSTALL_STATE,
  LocalMcpInstallStateError,
  LocalMcpInstallStateSchema,
} from '../../../src/lib/local-mcp-installs/store.ts';

const SHA = 'a'.repeat(64);
const record = {
  installId: `lmi_${'i'.repeat(22)}`,
  installedAt: '2026-11-02T09:00:00.000Z',
  name: 'search',
  origin: { kind: 'account', owner: 'claude-work', harness: 'claude', scope: 'user', id: 'a'.repeat(24) },
  provenance: {
    publisher: `fy_daemon_${'0'.repeat(43)}`,
    publisherName: 'This machine',
    catalogId: `cat_${'0'.repeat(22)}`,
    catalogName: 'MCP servers on this machine',
    itemId: `itm_${'s'.repeat(22)}`,
    kind: 'mcp',
    name: 'search',
    version: 1,
    digest: `sha256:${SHA}`,
  },
  target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
  destination: 'the server search in /srv/app/.mcp.json',
  key: 'project:/srv/app/.mcp.json#search',
  secretBindings: { API_TOKEN: 'MY_TOKEN', REGION: null },
  root: '/srv/app',
  entrySha256: SHA,
};

describe('what the machine remembers about MCP servers copied from itself', () => {
  it('is empty at first, and the empty state parses', () => {
    should(LocalMcpInstallStateSchema.safeParse(EMPTY_LOCAL_MCP_INSTALL_STATE).success).be.true();
    should(EMPTY_LOCAL_MCP_INSTALL_STATE.installs).deepEqual([]);
  });

  it('parses a project record and a runtime record', () => {
    const runtime = {
      ...record,
      target: { scope: 'runtime', runtime: 'claude-work', profile: 'work' },
      key: 'fleet:mcp/search',
      root: undefined,
      entrySha256: undefined,
      componentSha256: SHA,
    };
    for (const one of [record, runtime])
      should(LocalMcpInstallStateSchema.safeParse({ schemaVersion: 1, installs: [one] }).success).be.true();
  });

  it('refuses a record with a field it does not know or a hash that is not one', () => {
    for (const bad of [
      { ...record, extra: 1 },
      { ...record, entrySha256: 'nope' },
      { ...record, secretBindings: { API_TOKEN: 7 } },
    ])
      should(LocalMcpInstallStateSchema.safeParse({ schemaVersion: 1, installs: [bad] }).success).be.false();
  });

  it('names a damaged file by its own error', () => {
    const error = new LocalMcpInstallStateError('damaged');

    should(error).be.instanceOf(Error);
    should(error.name).equal('LocalMcpInstallStateError');
    should(error.message).equal('damaged');
  });

  it('carries a refusal’s code from the contract with its sentence', () => {
    const error = new LocalMcpRefusalError('local_mcp_conflict', 'in the way');

    should(error).be.instanceOf(Error);
    should(error.code).equal('local_mcp_conflict');
    should(error.message).equal('in the way');
    should(error.name).equal('LocalMcpRefusalError');
  });
});
