/**
 * What Onboarding keeps on disk. Today's first run kept its record of answers with the fleet's setup files
 * (`fleet/setup/import.json`, `clone-base.json`, `export-keys.json`); in 5.0 those three are the files of Runtimes'
 * setup service (proved by Runtimes' own tests, which the ledger rows F-0199, F-0427 and F-0428 point at), and
 * Onboarding keeps ONE state file of its own. This file proves the other half of that split: Onboarding declares no
 * file under the fleet's setup folder, no configuration file, and holds no filesystem root to write one with.
 */
import { describe, expect, test } from 'bun:test';
import { ONBOARDING_PROGRESS, ProgressSchema } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';

describe('storage parity', () => {
  test('Onboarding’s one state file is state/onboarding/progress.json, format 1, and it declares no configuration file', () => {
    expect(manifest.data.state.map(file => file.path)).toEqual(['progress.json']);
    expect(manifest.data.state[0]).toBe(ONBOARDING_PROGRESS);
    expect(ONBOARDING_PROGRESS.format).toBe(1);
    expect('config' in manifest.data).toBe(false);
  });

  test('Onboarding names no file of the fleet’s setup folder and holds no root, network, process or secret to reach one', () => {
    const declared = manifest.data.state.map(file => file.path);
    expect(declared.some(path => /setup|import|clone-base|export-keys/u.test(path))).toBe(false);
    expect(manifest.permissions).toEqual({ roots: [], network: [], spawn: [], secrets: [] });
  });

  test('progress.json holds the answers only: a step’s state and when it was answered, never a path or a value', () => {
    const answered = { state: 'found', at: '2026-11-16T09:00:00.000Z' };
    expect(ProgressSchema.safeParse({ format: 1, steps: { 'shells.nix': answered } }).success).toBe(true);
    const withPath = { ...answered, path: '/home/x/.claude' };
    expect(ProgressSchema.safeParse({ format: 1, steps: { 'shells.nix': withPath } }).success).toBe(false);
    expect(ProgressSchema.safeParse({ steps: { 'shells.nix': answered } }).success).toBe(false);
  });
});
