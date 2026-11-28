import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import {
  type Harness,
  PERSON_ORIGIN,
  type FerretRecord,
  type LaunchSpec,
  type PackedConversation,
} from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * C-45, the target's start of a ferret on a conversation that came from another machine (`StartRequest.relocated`): the
 * harness unpacks it into THIS ferret's own home once the home exists and before the pane opens; every refusal that can
 * be made first is made before the first write.
 */

const PACKED: PackedConversation = { bytes: new TextEncoder().encode('{"a":1}\n'), relPath: 'projects/-w/x.jsonl' };

function fixture(harness: FakeHarness | undefined) {
  const saved: FerretRecord[] = [];
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => ferretId('f1'),
    newName: () => 'fern1',
    save: async record => {
      saved.push(record);
    },
    saveTokens: async () => {},
    harness: key => (key === 'claude-code' ? harness : undefined),
    harnessKeys: () => ['claude-code'],
    runner: () => new FakeRunner(),
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return { saved, service: new FerretsService(new FerretRegistry([]), new FerretTokenDirectory(), ports) };
}

type Unpacks = Pick<Harness, 'unpackConversation'>;
function unpacking(order: string[]): FakeHarness & Unpacks {
  const harness: FakeHarness & Unpacks = Object.assign(new FakeHarness('claude-code'), {} as Unpacks);
  const prepare = harness.prepareHome.bind(harness);
  harness.prepareHome = async spec => {
    order.push('prepare');
    return await prepare(spec);
  };
  harness.hasConversation = async () => true;
  harness.unpackConversation = async (spec: LaunchSpec, packed: PackedConversation) => {
    order.push(`unpack:${spec.ferret}:${String(spec.folder)}:${packed.relPath}`);
    return ok({ conversation: 'moved-1' });
  };
  return harness;
}

describe('starting on a conversation that was moved here', () => {
  test('only a person may stage a stopped import; agents and daemon recovery write and launch nothing', async () => {
    const harness = unpacking([]);
    const { service, saved } = fixture(harness);
    for (const kind of ['agent', 'daemon'] as const) {
      const result = await service.start(
        { folder: '/work', harness: 'claude-code', by: 'owner', relocated: { ...PACKED, pending: true } },
        { kind },
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'refused' } });
    }
    expect(saved).toEqual([]);
    expect(harness.launched).toEqual([]);
    expect(harness.resumed).toEqual([]);
  });

  test('a pending relocation restores its conversation but opens no process, and resumes only explicitly', async () => {
    const harness = unpacking([]);
    const { service, saved } = fixture(harness);
    const imported = await service.start(
      { folder: '/work', harness: 'claude-code', by: 'owner', relocated: { ...PACKED, pending: true } },
      PERSON_ORIGIN,
    );
    expect(imported.ok).toBe(true);
    expect(harness.launched).toEqual([]);
    expect(harness.resumed).toEqual([]);
    expect(saved.at(-1)).toMatchObject({
      state: 'stopped',
      cause: { kind: 'stopped' },
      harnessConversation: 'moved-1',
    });
    expect(await service.heldLaunchRefusal(ferretId('f1'))).toContain('stopped on purpose');
    expect(await service.launchHeld(ferretId('f1'))).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(harness.resumed).toEqual([]);
    const resumed = await service.resume(ferretId('f1'), undefined, { origin: PERSON_ORIGIN });
    expect(resumed.ok).toBe(true);
    expect(harness.resumed).toEqual(['moved-1']);
  });

  test('the harness unpacks into the new ferret’s own home, after the home exists and before the pane', async () => {
    const order: string[] = [];
    const harness = unpacking(order);
    const { service } = fixture(harness);
    const started = await service.start(
      { folder: '/work', harness: 'claude-code', by: 'owner', relocated: PACKED },
      PERSON_ORIGIN,
    );
    expect(started.ok).toBe(true);
    expect(order).toEqual(['prepare', 'unpack:f1:/work:projects/-w/x.jsonl']);
    expect(harness.resumed).toEqual(['moved-1']);
  });

  test('a harness that refuses the pack fails the start with its sentence, and no pane is opened', async () => {
    const order: string[] = [];
    const harness = unpacking(order);
    harness.unpackConversation = async () =>
      err({ reason: 'Claude Code 9.9.9 was not tested for moving a conversation' });
    const { service } = fixture(harness);
    const started = await service.start(
      { folder: '/work', harness: 'claude-code', by: 'owner', relocated: PACKED },
      PERSON_ORIGIN,
    );
    expect(started).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(started)).toContain('was not tested');
    expect(harness.launched).toEqual([]);
    expect(harness.resumed).toEqual([]);
  });

  test('a harness whose unpack falls over fails the start in one sentence, and no pane is opened', async () => {
    const harness = unpacking([]);
    harness.unpackConversation = async () => {
      throw new Error('disk full');
    };
    const { service } = fixture(harness);
    const started = await service.start(
      { folder: '/work', harness: 'claude-code', by: 'owner', relocated: PACKED },
      PERSON_ORIGIN,
    );
    expect(started).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(started)).toContain('could not be written into this ferret');
    expect(harness.launched).toEqual([]);
  });

  test('only the owner may start one, and never beside another conversation: refused before any write', async () => {
    const harness = unpacking([]);
    const { service, saved } = fixture(harness);
    const byFerret = await service.start(
      { folder: '/work', harness: 'claude-code', by: 'ferret', relocated: PACKED },
      PERSON_ORIGIN,
    );
    const beside = await service.start(
      { folder: '/work', harness: 'claude-code', by: 'owner', relocated: PACKED, harnessConversation: 'other' },
      PERSON_ORIGIN,
    );
    expect(byFerret.ok).toBe(false);
    expect(beside.ok).toBe(false);
    expect(saved).toEqual([]);
  });

  test('a harness that cannot unpack is refused before any write', async () => {
    const { service, saved } = fixture(new FakeHarness('claude-code'));
    const started = await service.start(
      { folder: '/work', harness: 'claude-code', by: 'owner', relocated: PACKED },
      PERSON_ORIGIN,
    );
    expect(started).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(started)).toContain('cannot take a conversation moved');
    expect(saved).toEqual([]);
  });
});
