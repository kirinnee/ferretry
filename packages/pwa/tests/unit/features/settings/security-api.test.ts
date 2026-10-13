import { describe, expect, it } from 'bun:test';
import type { AuditView } from '@ferretry/protocol';
import {
  AUDIT_PATH,
  readSecurityLog,
  SECURITY_LOG_LIMIT,
  type SecurityLogClient,
} from '../../../../src/features/settings/security-api.ts';

const view: AuditView = { records: [], unreadable: 0 };

const recording = () => {
  const paths: string[] = [];
  const client: SecurityLogClient = {
    request: (async (path: string) => {
      paths.push(path);
      return view;
    }) as SecurityLogClient['request'],
  };
  return { client, paths };
};

describe('reading the security log', () => {
  it('asks the machine for the recent records, a hundred by default', async () => {
    const { client, paths } = recording();
    expect(await readSecurityLog(client)).toBe(view);
    expect(await readSecurityLog(client, 7)).toBe(view);
    expect(SECURITY_LOG_LIMIT).toBe(100);
    expect(paths).toEqual([`${AUDIT_PATH}?limit=100`, '/v1/audit?limit=7']);
  });
});
