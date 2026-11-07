import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ferrets from '@ferretry/core-ferrets/manifest';
import logins from '@ferretry/plugin-logins/manifest';
import runtimes from '../../../manifest.ts';
import { FERRET_ROUTE, readRuntimeSessionView } from '../../../app/lib/runtime-switch.ts';
import { scripted, type Call } from './support/client.ts';

/**
 * The shell's client throws "no compiled manifest declares" for a route key no manifest owns, and it matches the key
 * by its exact string (`:ferretId` is not `:id`). So every route key this app half calls must be declared by one of
 * the manifests it calls (its own, Ferrets', Logins').
 */

const APP = join(import.meta.dir, '../../../app');
const ROUTE_KEY = /['"`]((?:GET|POST|PUT|PATCH|DELETE) \/v1\/[^'"`\s]*)['"`]/gu;

const declared = new Set(
  [runtimes, ferrets, logins].flatMap(manifest => manifest.actions.routes.map(route => route.key as string)),
);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/u.test(name)) yield path;
  }
}

describe('the routes the Runtimes app calls', () => {
  test('every route key written in the app half is declared by a manifest it calls', () => {
    const undeclared: string[] = [];
    let seen = 0;
    for (const file of sources(APP)) {
      for (const match of readFileSync(file, 'utf8').matchAll(ROUTE_KEY)) {
        seen += 1;
        const key = match[1] as string;
        if (!declared.has(key)) undeclared.push(`${file.slice(APP.length + 1)}: ${key}`);
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(undeclared).toEqual([]);
  });

  test('the ferret detail read uses the parameter name Ferrets declares, and sends it under that name', async () => {
    expect(declared.has(FERRET_ROUTE)).toBe(true);
    const calls: Call[] = [];
    const client = scripted(
      { [FERRET_ROUTE]: { config: { id: 'f-1', harness: 'codex' }, state: { status: 'running' } } },
      calls,
    );
    await readRuntimeSessionView(client, 'f-1');
    expect(calls).toEqual([
      { route: 'GET /v1/ferrets/:ferretId', params: { ferretId: 'f-1' }, query: undefined, body: undefined },
    ]);
  });
});
