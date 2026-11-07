/** R513: only the three audited routes opt in to compression; adding one is a visible, reviewed change here. */
import { describe, expect, test } from 'bun:test';
import { loadManifests, loadWorkspace } from '../lib/workspace.ts';

const ALLOWED = new Set(['GET /v1/sessions', 'GET /v1/board', 'GET /v1/board/ids']);

describe('R513 compression opt-in allowlist', () => {
  test('R513 every route with compress: true is one of GET /v1/sessions, GET /v1/board, GET /v1/board/ids', async () => {
    const { loaded } = await loadManifests(loadWorkspace(process.cwd()));
    const opted = loaded.flatMap(({ manifest }) =>
      (manifest.actions?.routes ?? []).filter(route => route.compress === true).map(route => route.key),
    );
    expect(opted.filter(key => !ALLOWED.has(key))).toEqual([]);
  });
});
