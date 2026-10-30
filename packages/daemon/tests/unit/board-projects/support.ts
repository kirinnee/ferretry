import type { ProjectInfo } from '@ferretry/protocol';

export const FERRETRY_ID = '11111111-1111-4111-8111-111111111111';
export const DOCS_ID = '22222222-2222-4222-8222-222222222222';

export function project(id: string, path: string, commonDirectory?: string): ProjectInfo {
  return {
    id,
    name: path.split('/').pop() ?? path,
    path,
    source: 'existing-folder',
    createdAt: '2026-08-04T00:00:00.000Z',
    ...(commonDirectory === undefined ? {} : { git: { commonDirectory } }),
  };
}
