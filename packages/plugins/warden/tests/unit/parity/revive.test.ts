import { describe, expect, test } from 'bun:test';
import { ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { owner } from '@ferretry/kernel/testing';
import { wardenHost } from './host.ts';

describe('auto-revive in the running daemon half', () => {
  test('a ferret that only stopped is never revived: 5.0 Ferrets reports no death cause (GAP), so no resume is spent', async () => {
    // Arrange: the Warden on, revive on and allowed to resume alone, and an auto ferret that stopped
    const { host, ferrets } = await wardenHost({
      config: { enabled: true, revive: { enabled: true }, mayActAlone: { resume: true } },
    });
    ferrets.add({ id: ferretId('f1'), mode: 'auto', parent: ferretId('lead'), state: 'stopped', stateAt: T0 });

    // Act
    const ran = await host.request('POST', '/v1/warden/run', { body: { spawn: false }, as: owner() });

    // Assert
    expect(ran.status).toBe(200);
    expect(ferrets.resumes).toEqual([]);
    expect(ferrets.starts).toEqual([]);
  });
});
