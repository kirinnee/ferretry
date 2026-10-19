import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { readPersistedFast, readPersistedReasoningEffort } from '../../../../src/adapters/index.ts';

/**
 * Reading the level a runtime will start on from its own home, on a real filesystem.
 *
 * One Claude home and one Codex home, each holding the file its harness persists the level in, and
 * the three ways the read must come back empty rather than fail a launch: no home, a relative home
 * and a home whose file is missing.
 */

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function home(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'fy-runtime-home-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

describe('readPersistedReasoningEffort', () => {
  it("should read a Claude runtime's settings.json effortLevel", async () => {
    const claude = home({ 'settings.json': '{"effortLevel":"high"}', 'config.toml': 'model_reasoning_effort = "low"' });

    should(await readPersistedReasoningEffort('claude', claude)).equal('high');
  });

  it("should read a Codex runtime's config.toml model_reasoning_effort", async () => {
    const codex = home({ 'config.toml': 'model = "gpt-5"\nmodel_reasoning_effort = "xhigh"\n' });

    should(await readPersistedReasoningEffort('codex', codex)).equal('xhigh');
  });

  it('should answer nothing for an absent home, a relative home or a missing file', async () => {
    should(await readPersistedReasoningEffort('claude', undefined)).be.undefined();
    should(await readPersistedReasoningEffort('claude', 'relative/home')).be.undefined();
    should(await readPersistedReasoningEffort('codex', home({}))).be.undefined();
  });
});

describe('readPersistedFast', () => {
  it("should read a Claude runtime's saved fastMode, on or off", async () => {
    should(await readPersistedFast('claude', home({ 'settings.json': '{"fastMode":true}' }))).equal(true);
    should(await readPersistedFast('claude', home({ 'settings.json': '{"fastMode":false}' }))).equal(false);
  });

  it("should read a Codex runtime's saved service tier, either spelling of fast and the default", async () => {
    should(await readPersistedFast('codex', home({ 'config.toml': 'service_tier = "fast"\n' }))).equal(true);
    should(await readPersistedFast('codex', home({ 'config.toml': 'service_tier = "default"\n' }))).equal(false);
  });

  it('should answer nothing for an absent home, a relative home, a missing file or a file that says nothing', async () => {
    should(await readPersistedFast('claude', undefined)).be.undefined();
    should(await readPersistedFast('claude', 'relative/home')).be.undefined();
    should(await readPersistedFast('codex', home({}))).be.undefined();
    should(await readPersistedFast('claude', home({ 'settings.json': '{}' }))).be.undefined();
  });
});
