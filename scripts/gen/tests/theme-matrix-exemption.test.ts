/**
 * `context-imports`, the third exemption: the app's theme-matrix specimen page (and only it) mounts Conversation's real
 * `FyRenderBlock` so the hypermedia probe measures what the renderer draws. Every other reach stays refused.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type ImportEdge, areaOf, resolveSpecifier } from '../lib/imports.ts';
import { loadWorkspace } from '../lib/workspace.ts';
import { refusal } from '../../validate/context-imports.ts';

const ws = loadWorkspace(join(import.meta.dir, '..', '..', '..'));

function edge(fromPackage: string, fromFile: string, specifier: string): ImportEdge {
  const fromPkg = ws.byName(fromPackage);
  if (fromPkg === undefined) throw new Error(`no package ${fromPackage}`);
  const from = join(fromPkg.dir, fromFile);
  return {
    from,
    fromPkg,
    fromArea: areaOf(fromPkg, from),
    specifier,
    line: 1,
    typeOnly: false,
    kind: 'import',
    ...resolveSpecifier(ws, from, specifier),
  };
}

const SCENE = 'tests/integration/fixtures/theme-matrix-scene.tsx';
const BLOCK = '../../../../plugins/conversation/app/render/fy-render-block.tsx';
const GRAMMAR = '../../../../plugins/conversation/app/render/fy-render.ts';

describe('context-imports: the theme matrix specimen mounts the real fy-render block', () => {
  test('the specimen page may import the block and its grammar', () => {
    expect(refusal(edge('@ferretry/app', SCENE, BLOCK))).toBeUndefined();
    expect(refusal(edge('@ferretry/app', SCENE, GRAMMAR))).toBeUndefined();
  });

  test('no other app test file may, and no other renderer file may be reached', () => {
    expect(refusal(edge('@ferretry/app', 'tests/integration/fixtures/frame-scene.tsx', BLOCK))).toContain(
      'another package is reached only through its contract',
    );
    expect(
      refusal(edge('@ferretry/app', SCENE, '../../../../plugins/conversation/app/render/fy-render-theme.ts')),
    ).toContain('another package is reached only through its contract');
  });
});
