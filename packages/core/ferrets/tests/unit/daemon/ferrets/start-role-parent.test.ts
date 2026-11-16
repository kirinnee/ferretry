import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import type { InstructionEntry } from '@ferretry/kernel/contract';
import type { FerretRecord } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { applicableInstructions } from '../../../../daemon/lib/ferrets/launch-sections.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * ONE RULE: a ferret with a parent is never role `lead`. A start that POSTs `role: 'lead'` beside a parent is recorded
 * as a helper (v4 derived the role from the parent alone), so the lead-only instruction sections (`when: {role: 'lead'}`)
 * never reach a sub-ferret that is also told it is one. Fixture values only.
 */

const parentRecord: FerretRecord = {
  format: 1,
  id: ferretId('boss'),
  name: 'boss',
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work',
  state: 'idle',
  createdAt: T0,
  stateAt: T0,
};

function fixture() {
  const registry = new FerretRegistry([parentRecord]);
  const tokens = new FerretTokenDirectory();
  const runner = new FakeRunner();
  const harness = new FakeHarness('claude-code', '/fixture-fy/state/claude-code/agent-homes');
  const decided: string[] = [];
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => ferretId('kid'),
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: key => (key === 'claude-code' ? harness : undefined),
    harnessKeys: () => ['claude-code'],
    runner: () => runner,
    decide: async input => {
      decided.push(input.role);
      return { allow: true };
    },
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return { registry, decided, service: new FerretsService(registry, tokens, ports) };
}

const entry = (id: string, when: InstructionEntry['when']): InstructionEntry => ({ id, text: id, when }) as never;

describe('a start with a role and a parent', () => {
  test('role lead beside a parent is recorded as a helper, and the lead-only hook filter does not match it', async () => {
    const f = fixture();

    const started = await f.service.start(
      { folder: '/work', by: 'owner', role: 'lead', parent: parentRecord.id },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const record = f.registry.get(started.value);
    expect(record?.role).toBe('helper');
    expect(record?.parent).toBe(parentRecord.id);
    expect(f.decided).toEqual(['helper']);

    const sections = applicableInstructions(
      [entry('lead-only', { role: 'lead' }), entry('helper-only', { role: 'helper' })],
      { role: record!.role, harness: record!.harness },
    ).map(each => each.id);
    expect(sections).toEqual(['helper-only']);
  });

  test('a lead with no parent stays a lead, and a parent with no role is a helper', async () => {
    const lead = fixture();
    const alone = await lead.service.start({ folder: '/work', by: 'owner', role: 'lead' }, PERSON_ORIGIN);
    expect(alone.ok && lead.registry.get(alone.value)?.role).toBe('lead');

    const child = fixture();
    const kid = await child.service.start({ folder: '/work', by: 'owner', parent: parentRecord.id }, PERSON_ORIGIN);
    expect(kid.ok && child.registry.get(kid.value)?.role).toBe('helper');
  });
});
