import { describe, expect, it } from 'bun:test';
import {
  configErrorCode,
  configInvalidBody,
  confirmConfigChange,
  readConfigFile,
  readConfigStatus,
  writeConfigFile,
} from '../../../../src/features/config-files/config-files-api.ts';
import { alpha, fakeClients, fileView, httpError, STATUS } from './config-files-support.ts';

describe('the configuration files client', () => {
  it('reads the status, and one file by its path, escaped', async () => {
    const { calls, createClient } = fakeClients({
      'GET /v1/config/status': () => STATUS,
      'GET /v1/config/file': () => fileView({ path: 'components/mcp/git hub.yaml' }),
    });
    const client = await createClient(alpha);
    expect(await readConfigStatus(client)).toEqual(STATUS);
    expect((await readConfigFile(client, 'components/mcp/git hub.yaml')).path).toBe('components/mcp/git hub.yaml');
    expect(calls.map(call => call.path)).toEqual([
      '/v1/config/status',
      '/v1/config/file?path=components%2Fmcp%2Fgit%20hub.yaml',
    ]);
  });

  it('writes against the etag it was edited from, in If-Match, and confirms by path and etag', async () => {
    const { calls, createClient } = fakeClients({
      'PUT /v1/config/file': () => ({ path: 'machine.yaml', etag: 'etag-2', outcome: 'applied' }),
      'POST /v1/config/confirm': () => ({ path: 'machine.yaml', confirmed: true }),
    });
    const client = await createClient(alpha);
    expect(await writeConfigFile(client, 'machine.yaml', 'agentPermissions: auto\n', 'etag-1')).toEqual({
      path: 'machine.yaml',
      etag: 'etag-2',
      outcome: 'applied',
    });
    expect(await confirmConfigChange(client, 'machine.yaml', 'etag-2')).toEqual({
      path: 'machine.yaml',
      confirmed: true,
    });
    const [put, confirm] = calls;
    expect(put?.headers.get('if-match')).toBe('etag-1');
    expect(put?.headers.get('content-type')).toBe('application/json');
    expect(put?.body).toEqual({ path: 'machine.yaml', text: 'agentPermissions: auto\n' });
    expect(confirm?.body).toEqual({ path: 'machine.yaml', etag: 'etag-2' });
  });

  it('reads the located issues out of a 422, and nothing out of anything else', () => {
    const issues = STATUS.issues;
    const invalid = httpError('the file does not check', 422, 'config_invalid', {
      error: 'the file does not check',
      code: 'config_invalid',
      issues,
    });
    expect(configInvalidBody(invalid)?.issues).toEqual(issues);
    expect(configInvalidBody(httpError('the file does not check', 422, 'config_invalid'))).toBeUndefined();
    expect(configInvalidBody(httpError('changed', 409, 'config_conflict', { error: 'changed' }))).toBeUndefined();
    expect(configInvalidBody('a string')).toBeUndefined();
    expect(configInvalidBody(null)).toBeUndefined();
  });

  it('names the refusal code when there is one', () => {
    expect(configErrorCode(httpError('changed', 409, 'config_conflict'))).toBe('config_conflict');
    expect(configErrorCode(new Error('offline'))).toBeUndefined();
    expect(configErrorCode(null)).toBeUndefined();
  });
});
