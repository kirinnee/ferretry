import { describe, it } from 'bun:test';
import should from 'should';
import {
  launchReasoningEffort,
  persistedReasoningEffort,
  RUNTIME_SETTINGS_FILE,
} from '../../../../src/lib/session/harness/launch-effort.ts';

/**
 * The level a brand-new session starts on, read before the harness has said anything about itself.
 *
 * What matters is what these REFUSE: a level under a profile the launch did not select, a value that
 * is prose rather than a level, and a malformed document are all "no evidence", never an error.
 */

describe('persistedReasoningEffort', () => {
  it('should name the file each harness persists its level in', () => {
    should(RUNTIME_SETTINGS_FILE).deepEqual({ claude: 'settings.json', codex: 'config.toml' });
  });

  it("should read Claude's effortLevel, normalised", () => {
    should(persistedReasoningEffort('claude', '{"effortLevel":" High ","model":"x"}')).equal('high');
  });

  it('should answer nothing for a Claude document that names no usable level', () => {
    should(persistedReasoningEffort('claude', '{"model":"x"}')).be.undefined();
    should(persistedReasoningEffort('claude', '{"effortLevel":3}')).be.undefined();
    should(persistedReasoningEffort('claude', '{"effortLevel":"think very hard please"}')).be.undefined();
    should(persistedReasoningEffort('claude', '[]')).be.undefined();
    should(persistedReasoningEffort('claude', 'null')).be.undefined();
    should(persistedReasoningEffort('claude', '{not json')).be.undefined();
    should(persistedReasoningEffort('claude', undefined)).be.undefined();
  });

  it("should read Codex's root model_reasoning_effort in either quote style, with a trailing comment", () => {
    should(persistedReasoningEffort('codex', 'model = "gpt-5"\nmodel_reasoning_effort = "xhigh"\n')).equal('xhigh');
    should(persistedReasoningEffort('codex', "model_reasoning_effort='low' # cheap\r\n")).equal('low');
  });

  it('should ignore a level that belongs to a profile table the launch did not select', () => {
    should(
      persistedReasoningEffort('codex', 'model = "gpt-5"\n\n[profiles.deep]\nmodel_reasoning_effort = "high"\n'),
    ).be.undefined();
  });

  it('should answer nothing for a Codex document that names no level', () => {
    should(persistedReasoningEffort('codex', 'model = "gpt-5"\n')).be.undefined();
    should(persistedReasoningEffort('codex', 'model_reasoning_effort = high\n')).be.undefined();
    should(persistedReasoningEffort('codex', undefined)).be.undefined();
  });
});

describe('launchReasoningEffort', () => {
  it("should prefer the start request's level over the runtime's persisted one", () => {
    should(launchReasoningEffort('Max', 'high')).equal('max');
  });

  it('should fall back to the persisted level, then to none at all', () => {
    should(launchReasoningEffort(undefined, 'high')).equal('high');
    should(launchReasoningEffort('   ', 'medium')).equal('medium');
    should(launchReasoningEffort(undefined, undefined)).be.undefined();
  });
});
