import { describe, it } from 'bun:test';
import should from 'should';
import {
  launchReasoningEffort,
  persistedFast,
  persistedReasoningEffort,
  RUNTIME_SETTINGS_FILE,
} from '../../daemon/lib/launch-effort.ts';

/**
 * The level a brand-new session starts on, read before the harness has said anything about itself.
 *
 * What matters is what these REFUSE: a level under a profile the launch did not select, a value that
 * is prose rather than a level, and a malformed document are all "no evidence", never an error.
 */

describe('persistedReasoningEffort', () => {
  it('should name the file Codex persists its level in', () => {
    should(RUNTIME_SETTINGS_FILE).equal('config.toml');
  });

  it("should read Codex's root model_reasoning_effort in either quote style, with a trailing comment", () => {
    should(persistedReasoningEffort('model = "gpt-5"\nmodel_reasoning_effort = "xhigh"\n')).equal('xhigh');
    should(persistedReasoningEffort("model_reasoning_effort='low' # cheap\r\n")).equal('low');
  });

  it('should ignore a level that belongs to a profile table the launch did not select', () => {
    should(
      persistedReasoningEffort('model = "gpt-5"\n\n[profiles.deep]\nmodel_reasoning_effort = "high"\n'),
    ).be.undefined();
  });

  it('should answer nothing for a Codex document that names no level', () => {
    should(persistedReasoningEffort('model = "gpt-5"\n')).be.undefined();
    should(persistedReasoningEffort('model_reasoning_effort = high\n')).be.undefined();
    should(persistedReasoningEffort(undefined)).be.undefined();
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

describe('persistedFast', () => {
  it("should read Codex's root service_tier: fast and priority are on, default is off, anything else is no answer", () => {
    should(persistedFast('model = "gpt-6"\nservice_tier = "fast"\n')).equal(true);
    should(persistedFast("service_tier = 'priority' # fastest\r\n")).equal(true);
    should(persistedFast('service_tier = "default"\n')).equal(false);
    should(persistedFast('service_tier = "ultrafast"\n')).be.undefined();
    should(persistedFast('service_tier = fast\n')).be.undefined();
    should(persistedFast('model = "gpt-6"\n')).be.undefined();
    should(persistedFast(undefined)).be.undefined();
  });

  it('should ignore a service tier that belongs to a profile table the launch did not select', () => {
    should(persistedFast('model = "gpt-6"\n\n[profiles.quick]\nservice_tier = "fast"\n')).be.undefined();
  });
});
