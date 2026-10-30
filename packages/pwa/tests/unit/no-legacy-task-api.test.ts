import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

const sources = (directory: string): readonly string[] =>
  readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });

// The old per-session and fleet task routes: `/v1/sessions/${id}/tasks`, `/v1/tasks`, or a `taskPath` helper.
const LEGACY = [/\/v1\/sessions\/[^'"`\s]*\/tasks\b/u, /['"`]\/v1\/tasks\b/u, /\btaskPath\b/u];

describe('the PWA and its harness no longer reach the retired task API', () => {
  const files = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'harness'))];

  test('scans the code it claims to', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test('no file spells a request to /v1/sessions/:sid/tasks or /v1/tasks', () => {
    const offenders = files.flatMap(file => {
      const text = readFileSync(file, 'utf8');
      return LEGACY.filter(pattern => pattern.test(text)).map(pattern => `${relative(ROOT, file)} ~ ${pattern}`);
    });
    expect(offenders).toEqual([]);
  });
});
