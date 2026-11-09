/**
 * The model Runtimes assembles from the components its owners provide: a kind that was read is real (and never stood in
 * for), a kind that was not is a stand-in that is named, an environment login's templates are used when Logins gave them
 * and stood in for when it withheld them, and Runtimes' own instructions are read from its own collection.
 */
import { describe, expect, it } from 'bun:test';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { InstructionsFile, ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { ownInstructionsSource } from '../../../daemon/adapters/own-instructions-source.ts';
import { readProfileComponents, type Within, withinMs } from '../../../daemon/adapters/profile-components.ts';
import {
  assembleRuntimesModel,
  type ComponentReading,
  NO_COMPONENTS,
  type RuntimesFiles,
  standInsNamedBy,
} from '../../../daemon/lib/account/runtimes-model.ts';
import { adaptProfile } from '../../../daemon/lib/account/adapt.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { claudeStatuslineFor } from '../../../daemon/lib/account/statusline.ts';

const runtime = (login: string): RuntimeFile => ({ login, profile: 'default', agent: false }) as RuntimeFile;
const profile = (contents: readonly string[]): ProfileFile => ({ contents: [...contents] }) as ProfileFile;

const read = (components: Record<string, unknown>): ComponentReading['mcp'] => ({
  state: 'read',
  components: new Map(Object.entries(components)),
});

const files = (overrides: Partial<RuntimesFiles> = {}): RuntimesFiles => ({
  runtimes: new Map([['claude-default', runtime('claude-you')]]),
  profiles: new Map([['default', profile(['modelSets/heavy'])]]),
  modelSets: new Map([['heavy', { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' }]]),
  settings: undefined,
  logins: [sampleLogin('claude-you', { store: 'ferretry' })],
  templates: new Map(),
  components: NO_COMPONENTS,
  ...overrides,
});

describe('a kind whose owners answered', () => {
  it('is in the model as the owner projected it, and nothing stands in for it', () => {
    const assembled = assembleRuntimesModel(
      files({
        profiles: new Map([['default', profile(['modelSets/heavy', 'mcp/github'])]]),
        components: { ...NO_COMPONENTS, mcp: read({ github: { command: 'github-mcp' } }) },
      }),
    );

    expect(assembled.model.components.mcp.github).toMatchObject({ command: 'github-mcp' });
    expect(assembled.unreadable).toEqual([]);
  });

  it('shows the owner’s components even when no layer names them', () => {
    const assembled = assembleRuntimesModel(
      files({ components: { ...NO_COMPONENTS, skills: read({ review: { items: ['review'] } }) } }),
    );

    expect(Object.keys(assembled.model.components.skills)).toEqual(['review']);
  });

  it('refuses, by name, a layer naming a component its owner does not have (a real gap, not a stand-in)', () => {
    expect(() =>
      assembleRuntimesModel(
        files({
          profiles: new Map([['default', profile(['modelSets/heavy', 'mcp/missing'])]]),
          components: { ...NO_COMPONENTS, mcp: read({}) },
        }),
      ),
    ).toThrow(/missing/u);
  });
});

describe('a kind whose owners did not answer', () => {
  it('stands in for the named components, keeps the layer, and names why without a value', () => {
    const assembled = assembleRuntimesModel(
      files({
        profiles: new Map([['default', profile(['modelSets/heavy', 'mcp/github'])]]),
        components: {
          ...NO_COMPONENTS,
          mcp: { state: 'unread', reason: 'the part of Ferretry that owns them did not answer' },
        },
      }),
    );

    expect(assembled.model.profiles.default?.layers).toEqual(['modelSets/heavy', 'mcp/github']);
    expect(assembled.unreadable).toEqual([
      'the mcp component "github" could not be read from the part of Ferretry that owns it: the part of Ferretry that owns them did not answer',
    ]);
  });
});

describe('an environment login', () => {
  const glm = sampleLogin('glm', {
    store: 'environment',
    environment: {
      variables: [],
      quotaSource: 'none',
      missingSecrets: [],
      test: { available: false, reason: 'x' },
    } as never,
  });

  it('uses the templates Logins gave: a secret stays a reference and nothing stands in', () => {
    const assembled = assembleRuntimesModel(
      files({
        logins: [glm],
        runtimes: new Map([['glm-work', runtime('glm')]]),
        templates: new Map([
          [
            'glm',
            { kind: 'templates', id: 'glm', harness: 'claude-code', env: { TOKEN: '${secret:GLM_KEY}', REGION: 'eu' } },
          ],
        ]),
      }),
    );

    expect(assembled.model.credentials.glm?.env).toEqual({ TOKEN: '${secret:GLM_KEY}', REGION: 'eu' });
    expect(assembled.unreadable).toEqual([]);
  });

  it('is stood in for, and named, when Logins withheld its file: the withheld names carry no value into the model', () => {
    const assembled = assembleRuntimesModel(
      files({
        logins: [glm],
        runtimes: new Map([['glm-work', runtime('glm')]]),
        templates: new Map([['glm', { kind: 'withheld', id: 'glm', harness: 'claude-code', variables: ['TOKEN'] }]]),
      }),
    );

    expect(assembled.unreadable).toEqual([]);
    expect(assembled.stoodInLogins).toHaveLength(1);
    expect(assembled.stoodInLogins[0]?.because).toContain('withheld');
    expect(JSON.stringify(assembled.model.credentials.glm)).not.toContain('GLM_KEY');
  });

  it('m3 a withheld login that no runtime names holds nothing back, and one a runtime names still does', () => {
    const withheld = new Map([
      ['glm', { kind: 'withheld' as const, id: 'glm', harness: 'claude-code' as const, variables: ['TOKEN'] }],
    ]);

    const unused = assembleRuntimesModel(
      files({ logins: [sampleLogin('claude-you', { store: 'ferretry' }), glm], templates: withheld }),
    );
    const used = assembleRuntimesModel(
      files({
        logins: [sampleLogin('claude-you', { store: 'ferretry' }), glm],
        runtimes: new Map([
          ['claude-default', runtime('claude-you')],
          ['glm-work', runtime('glm')],
        ]),
        templates: withheld,
      }),
    );

    expect(unused.unreadable).toEqual([]);
    expect(used.unreadable).toEqual([]);
    expect(standInsNamedBy(unused.model, unused.stoodInLogins)).toEqual([]);
    expect(standInsNamedBy(used.model, used.stoodInLogins).map(login => login.id)).toEqual(['glm']);
  });

  it('is stood in for when Logins gave no templates at all (it could not answer)', () => {
    const assembled = assembleRuntimesModel(
      files({ logins: [glm], runtimes: new Map([['glm-work', runtime('glm')]]), templates: undefined }),
    );

    expect(assembled.unreadable).toEqual([]);
    expect(assembled.stoodInLogins).toHaveLength(1);
    expect(assembled.stoodInLogins[0]?.because).toContain('did not give');
  });
});

/** No deadline: the work is waited for. */
const noDeadline: Within = work => work;

/** A clock the test drives: `after` keeps the callback, `fire` runs every timer still waiting. */
function manualClock() {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    after: (_delayMs: number, fn: () => void) => {
      next += 1;
      const id = next;
      timers.set(id, fn);
      return () => {
        timers.delete(id);
      };
    },
    fire: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    waiting: () => timers.size,
  };
}

describe('m4 an owner that does not answer', () => {
  const ownEmpty = ownInstructionsSource({ collection: () => new Map() as never });
  const hang = new Promise<never>(() => undefined);

  it('leaves its kind unread, in a sentence, once the deadline passes: never a stuck read and never an empty answer', async () => {
    const clock = manualClock();
    const lookup = (hook: { name: string }) =>
      hook.name === 'runtimes.components.mcp'
        ? { list: async () => await hang, read: async () => undefined }
        : ('unavailable' as const);

    const reading = readProfileComponents(lookup as never, ownEmpty, withinMs(clock.after, 5_000));
    // The read is still waiting on the owner: only the clock lets it end.
    clock.fire();

    expect((await reading).mcp).toEqual({
      state: 'unread',
      reason: 'the part of Ferretry that owns them did not answer in time',
    });
  });

  it('an owner that answers in time is read, and its timer is cancelled', async () => {
    const clock = manualClock();
    const lookup = (hook: { name: string }) =>
      hook.name === 'runtimes.components.mcp'
        ? { list: async () => ['github'], read: async () => ({ command: 'github-mcp' }) }
        : ('unavailable' as const);

    const reading = await readProfileComponents(lookup as never, ownEmpty, withinMs(clock.after, 5_000));

    expect(reading.mcp).toMatchObject({ state: 'read', components: new Map([['github', { command: 'github-mcp' }]]) });
    // Every other source is not running (it never started a timer), and the answered one cancelled its own.
    expect(clock.waiting()).toBe(0);
  });
});

describe('reading every kind', () => {
  const none = () => 'unavailable' as const;
  const ownEmpty = ownInstructionsSource({ collection: () => new Map() as never });

  it('a kind with no provider is unread, and instructions are Runtimes’ own and read without a hook', async () => {
    const reading = await readProfileComponents(none, ownEmpty, noDeadline);

    expect(reading.mcp).toMatchObject({ state: 'unread' });
    // Settings and hooks come per harness: with neither running they give nothing, and every layer naming one is unread.
    expect(reading.settings).toMatchObject({ state: 'read', partial: expect.any(String) });
    expect(reading.hooks).toMatchObject({ state: 'read', partial: expect.any(String) });
    expect(reading.instructions).toEqual({ state: 'read', components: new Map() });
  });

  it('the instructions source gives Runtimes’ own items as text components, live', async () => {
    const held = new Map<string, InstructionsFile>([
      ['house', { text: 'Be brief.', harness: 'codex', description: 'ignored' }],
    ]);
    const own = ownInstructionsSource({ collection: () => held as never });

    const reading = await readProfileComponents(none, own, noDeadline);
    held.clear();
    const after = await readProfileComponents(none, own, noDeadline);

    expect(reading.instructions).toEqual({
      state: 'read',
      components: new Map([['house', { text: 'Be brief.', harness: 'codex' }]]),
    });
    expect(after.instructions).toEqual({ state: 'read', components: new Map() });
  });

  it('a source of one harness decides the component’s harness: a document claiming another one never overrides its owner', async () => {
    const lookup = (hook: { name: string }) =>
      hook.name === 'runtimes.components.settings.claude' || hook.name === 'runtimes.components.settings.codex'
        ? {
            list: async () => (hook.name.endsWith('claude') ? ['one'] : []),
            read: async () => ({ harness: 'codex', document: { a: 1 } }),
          }
        : ('unavailable' as const);

    const reading = await readProfileComponents(lookup as never, ownEmpty, noDeadline);

    expect(reading.settings).toEqual({
      state: 'read',
      components: new Map([['one', { harness: 'claude', document: { a: 1 } }]]),
    });
  });

  it('m1 a per-harness kind is read from the harness that runs when the other one is off, and says what it lacks', async () => {
    const claudeOnly = (hook: { name: string }) =>
      hook.name === 'runtimes.components.settings.claude'
        ? { list: async () => ['one'], read: async () => ({ harness: 'claude-code', document: { a: 1 } }) }
        : ('unavailable' as const);

    const reading = await readProfileComponents(claudeOnly as never, ownEmpty, noDeadline);

    expect(reading.settings).toMatchObject({
      state: 'read',
      components: new Map([['one', { harness: 'claude', document: { a: 1 } }]]),
      partial: expect.stringContaining('not running'),
    });
  });

  it('m1 a component the running harness lacks is unread BY NAME, and one it has is not', () => {
    const assembled = assembleRuntimesModel(
      files({
        profiles: new Map([['default', profile(['modelSets/heavy', 'settings/one', 'settings/codex-guard'])]]),
        components: {
          ...NO_COMPONENTS,
          settings: {
            state: 'read',
            components: new Map([['one', { harness: 'claude', document: { a: 1 } }]]),
            partial: 'the part of Ferretry that owns them is not running',
          },
        },
      }),
    );

    expect(assembled.unreadable).toHaveLength(1);
    expect(assembled.unreadable[0]).toContain('"codex-guard"');
    expect(assembled.model.components.settings.one).toMatchObject({ document: { a: 1 } });
  });

  it('m1 a single-owner kind is still unread when its owner is not running', async () => {
    const reading = await readProfileComponents((() => 'unavailable') as never, ownEmpty, noDeadline);

    expect(reading.mcp).toMatchObject({ state: 'unread' });
    expect(reading.skills).toMatchObject({ state: 'unread' });
  });
});

describe('an instructions component given as text', () => {
  const assemble = (components: ComponentReading) =>
    assembleRuntimesModel(files({ profiles: new Map([['default', profile(['instructions/house'])]]), components }))
      .model;

  it('is rendered as one generated document naming where to edit it, never linked to a file', () => {
    const model = assemble({ ...NO_COMPONENTS, instructions: read({ house: { text: 'Be brief.' } }) });
    const resolved = resolveProfile({ model, profile: 'default', harness: 'claude' });
    if (!resolved.ok) throw new Error('profile did not resolve');

    const adapted = adaptProfile({
      resolved: resolved.resolved,
      plumbing: { harness: 'claude', statusLine: claudeStatuslineFor('ferretry') },
      bodies: { instructions: { house: 'Be brief.' } },
    });

    expect(adapted.entries).toContainEqual(
      expect.objectContaining({ kind: 'generated', dest: 'CLAUDE.md', content: expect.stringContaining('Be brief.') }),
    );
    expect(adapted.entries.some(entry => entry.kind === 'link' || entry.kind === 'copy')).toBe(false);
  });

  it('refuses a component with both a file and text, or neither', () => {
    expect(() => assemble({ ...NO_COMPONENTS, instructions: read({ house: { text: 'x', file: 'a.md' } }) })).toThrow();
    expect(() => assemble({ ...NO_COMPONENTS, instructions: read({ house: {} }) })).toThrow();
  });
});
