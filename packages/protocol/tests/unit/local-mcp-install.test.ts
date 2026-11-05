import { describe, it } from 'bun:test';
import should from 'should';
import {
  LOCAL_MCP_INSTALLS_PATH,
  LOCAL_MCP_PREVIEW_TTL_SECONDS,
  LOCAL_MCP_REFUSALS,
  LocalMcpInstallIdSchema,
  LocalMcpInstallRequestSchema,
  LocalMcpPreviewIdSchema,
  LocalMcpPreviewRequestSchema,
  LocalMcpRefusalSchema,
  localMcpInstallsPath,
} from '../../src/lib/local-mcp-install.ts';

const PREVIEW = `lmp_${'a'.repeat(22)}`;

describe('copying an MCP server from this machine, on the wire', () => {
  it('has a route for each scope and a preview of each', () => {
    should(LOCAL_MCP_INSTALLS_PATH).equal('/v1/mcp-installs/local');
    should(localMcpInstallsPath('project')).equal('/v1/mcp-installs/local/project');
    should(localMcpInstallsPath('runtime', true)).equal('/v1/mcp-installs/local/runtime/preview');
  });

  it('gives a preview ten minutes, as a catalog install does', () => {
    should(LOCAL_MCP_PREVIEW_TTL_SECONDS).equal(600);
  });

  it('spells its ids lmp_ and lmi_ with 22 base64url characters', () => {
    should(LocalMcpPreviewIdSchema.safeParse(PREVIEW).success).be.true();
    should(LocalMcpPreviewIdSchema.safeParse(`lmi_${'a'.repeat(22)}`).success).be.false();
    should(LocalMcpInstallIdSchema.safeParse(`lmi_${'a-_'.repeat(7)}a`).success).be.true();
    should(LocalMcpInstallIdSchema.safeParse(`lmi_${'a'.repeat(21)}`).success).be.false();
  });

  it('takes a preview request naming the inventory’s id and a target, and no path', () => {
    const request = {
      source: { id: 'a'.repeat(24) },
      target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
    };

    should(LocalMcpPreviewRequestSchema.safeParse(request).success).be.true();
    should(LocalMcpPreviewRequestSchema.safeParse({ ...request, extra: 1 }).success).be.false();
    should(LocalMcpPreviewRequestSchema.safeParse({ ...request, source: { id: 'short' } }).success).be.false();
    should(LocalMcpPreviewRequestSchema.safeParse({ ...request, source: { path: '/x/.mcp.json' } }).success).be.false();
  });

  it('applies by preview id and the person’s own secret bindings', () => {
    should(
      LocalMcpInstallRequestSchema.safeParse({ previewId: PREVIEW, secretBindings: { API_TOKEN: 'MY_TOKEN', R: null } })
        .success,
    ).be.true();
    should(LocalMcpInstallRequestSchema.safeParse({ previewId: PREVIEW }).success).be.false();
    should(
      LocalMcpInstallRequestSchema.safeParse({ previewId: PREVIEW, secretBindings: {}, extra: 1 }).success,
    ).be.false();
  });

  it('names eight refusals', () => {
    should(LOCAL_MCP_REFUSALS).have.length(8);
    for (const code of LOCAL_MCP_REFUSALS) should(LocalMcpRefusalSchema.safeParse(code).success).be.true();
    should(LocalMcpRefusalSchema.safeParse('catalog_downgrade').success).be.false();
  });
});
