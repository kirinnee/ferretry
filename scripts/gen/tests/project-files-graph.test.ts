/** `plugin-graph` (S179, K3): `permissions.projectFiles` is legal only with the `project-files` root, and each pattern is plain. */
import { describe, expect, test } from 'bun:test';
import type { Manifest } from '../../../packages/core/kernel/manifest/index.ts';
import { pluginGraphFindings, type StartGraph } from '../lib/graph.ts';

const graphOf = (...manifests: Manifest[]): StartGraph =>
  ({
    ids: manifests.map(m => m.id),
    manifests: new Map(manifests.map(m => [m.id, m])),
    providers: new Map(),
    offerers: new Map(),
    hooks: new Map(),
    before: new Map(),
    order: manifests.map(m => m.id),
  }) as unknown as StartGraph;

const manifest = (id: string, roots: string[], projectFiles?: string[]): Manifest =>
  ({
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    permissions: { roots, ...(projectFiles === undefined ? {} : { projectFiles }) },
  }) as unknown as Manifest;

const messages = (...manifests: Manifest[]): string[] =>
  pluginGraphFindings(graphOf(...manifests))
    .filter(finding => finding.message.includes('projectFiles') || finding.message.includes('project-files'))
    .map(finding => `${finding.where}: ${finding.message}`);

describe('plugin-graph: project-files', () => {
  test('S179 the two real shapes are accepted', () => {
    expect(
      messages(
        manifest('mcp', ['project-files'], ['.mcp.json']),
        manifest('skills', ['project-files', 'downloads'], ['.claude/skills/*/**', '.agents/skills/*/**']),
      ),
    ).toEqual([]);
  });

  test('S179 projectFiles without the root, and the root without a set, are refused', () => {
    expect(
      messages(
        manifest('a', ['downloads'], ['.mcp.json']),
        manifest('b', ['project-files']),
        manifest('c', ['project-files'], []),
      ),
    ).toEqual([
      "a: declares permissions.projectFiles without root 'project-files'",
      "b: declares root 'project-files' without permissions.projectFiles",
      "c: declares root 'project-files' without permissions.projectFiles",
    ]);
  });

  test('S179 a pattern with .., an absolute path, a bare ** or a leading * is refused with the reason', () => {
    const found = messages(manifest('mcp', ['project-files'], ['../x', '/abs', '**', '*/**', '.mcp.json']));
    expect(found).toHaveLength(4);
    expect(found[0]).toContain('"../x"');
    expect(found[1]).toContain('"/abs"');
    expect(found[2]).toContain('"**"');
    expect(found[3]).toContain('"*/**"');
  });
});
