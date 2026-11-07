import { describe, expect, test } from 'bun:test';
import type { BearerDigest } from '@ferretry/core-gate/contract';
import type { Instant } from '@ferretry/std';
import type { FerretId, FerretRecord, FerretsApi } from '../../../../contract/index.ts';
import { mayTouchConformance, T0, workFoldersConformance } from '../../../../contract/testing/index.ts';
import { ConditionalFleetList, entityTag } from '../../../../daemon/lib/fleet-list/conditional.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory, issueToken, tokenDigest } from '../../../../daemon/lib/tokens/tokens.ts';
import { RegistryWorkFolders } from '../../../../daemon/lib/work-folders/work-folders.ts';

const record = (id: string, parent?: string, folder = `/work/${id}`): FerretRecord => ({
  format: 1,
  id: id as FerretId,
  name: id,
  ...(parent === undefined ? {} : { parent: parent as FerretId }),
  role: parent === undefined ? 'lead' : 'helper',
  harness: 'claude-code',
  runner: 'tmux',
  folder,
  state: 'working',
  createdAt: T0,
  stateAt: T0,
});

mayTouchConformance('FerretRegistry', () => {
  const registry = new FerretRegistry();
  return {
    ferrets: { mayTouch: (a: FerretId, b: FerretId) => registry.mayTouch(a, b) } as FerretsApi,
    add: (id, parent) => registry.put(record(id, parent)),
  };
});

workFoldersConformance('RegistryWorkFolders', () => {
  const registry = new FerretRegistry([record('f1', undefined, '/work/project')]);
  return { folders: new RegistryWorkFolders(registry), ferret: 'f1' as FerretId, folder: '/work/project' };
});

describe('lineage', () => {
  test('G43 an unknown ferret, a cycle and a chain past the depth limit are never an ancestor', () => {
    const chain = Array.from({ length: 20 }, (_, index) =>
      record(`c${index}`, index === 0 ? undefined : `c${index - 1}`),
    );
    const registry = new FerretRegistry([...chain, record('x', 'y'), record('y', 'x')]);
    expect(registry.mayTouch('c0' as FerretId, 'c5' as FerretId)).toBe(true);
    expect(registry.mayTouch('c0' as FerretId, 'c19' as FerretId)).toBe(false);
    expect(registry.mayTouch('x' as FerretId, 'y' as FerretId)).toBe(true);
    expect(registry.isAncestorOf('nobody' as FerretId, 'x' as FerretId)).toBe(false);
  });

  test('a summary is the same object while its record has not moved', () => {
    const registry = new FerretRegistry([record('a'), record('b')]);
    const [a] = registry.list();
    registry.put(record('b'));
    expect(registry.list()[0]).toBe(a as never);
  });
});

describe('ferret tokens', () => {
  test('a token is fys_ and 43 base64url characters; only its digest is kept', () => {
    const issued = issueToken('f1' as FerretId, T0 as Instant);
    expect(issued.token).toMatch(/^fys_[A-Za-z0-9_-]{43}$/u);
    expect(issued.entry.digest).toBe(tokenDigest(issued.token));
    expect(JSON.stringify(issued.entry)).not.toContain('fys_');
  });

  test('the directory names a ferret by digest; a new token revokes the old one; revoke ends it', () => {
    const directory = new FerretTokenDirectory();
    const first = issueToken('f1' as FerretId, T0 as Instant);
    directory.add(first.entry);
    expect(directory.ferretFor(first.entry.digest as BearerDigest)).toBe('f1' as FerretId);
    const second = issueToken('f1' as FerretId, T0 as Instant);
    directory.add(second.entry);
    expect(directory.ferretFor(first.entry.digest as BearerDigest)).toBeUndefined();
    expect(directory.ferretFor(second.entry.digest as BearerDigest)).toBe('f1' as FerretId);
    const before = directory.generation();
    expect(directory.revoke('f1' as FerretId)).toBe(true);
    expect(directory.generation()).toBeGreaterThan(before);
    expect(directory.ferretFor(second.entry.digest as BearerDigest)).toBeUndefined();
    expect(directory.ferretFor('zz' as BearerDigest)).toBeUndefined();
  });
});

describe('the conditional fleet list', () => {
  test('R501 the tag is a digest of the body; R503 the same objects answer 304 without rendering again', () => {
    const registry = new FerretRegistry([record('a')]);
    const list = new ConditionalFleetList();
    const first = list.answer(registry.list(), undefined);
    expect(first.headers.get('etag')).toBe(entityTag(first.body));
    const second = list.answer(registry.list(), first.headers.get('etag'));
    expect(second.status).toBe(304);
    expect(list.answer(registry.list(), `W/${first.headers.get('etag')}`).status).toBe(304);
    registry.put({ ...record('a'), name: 'renamed' });
    const moved = list.answer(registry.list(), first.headers.get('etag'));
    expect(moved.status).toBe(200);
    expect(moved.headers.get('etag')).not.toBe(first.headers.get('etag'));
  });
});
