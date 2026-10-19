import { describe, expect, it } from 'bun:test';
import { refreshLocalModels } from '../../../../src/features/fleet/local-models-api.ts';
import { localModelsFixture } from '../../../support/local-models.ts';
import { type Call, scripted } from './account-support.ts';

describe('refreshLocalModels', () => {
  it('POSTs the refresh once and parses the daemon’s answer', async () => {
    const calls: Call[] = [];
    const answer = localModelsFixture('found');
    const client = scripted({ 'POST /v1/models/local/refresh': answer }, calls);
    expect(await refreshLocalModels(client)).toEqual(answer);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({});
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('refuses an answer that is not the schema', async () => {
    const client = scripted({ 'POST /v1/models/local/refresh': { state: 'found' } });
    await expect(refreshLocalModels(client)).rejects.toThrow();
  });
});
