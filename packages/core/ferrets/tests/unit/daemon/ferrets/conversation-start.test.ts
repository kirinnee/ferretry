import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import {
  type ConversationStageSource,
  FerretFiles,
  FerretTokensFile,
  type HarnessKey,
} from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { as, fakePacks, fakeStageOwner, host, record } from './route-fixture.ts';

/**
 * "Continue a past conversation" (O8-12) through the REAL Ferrets daemon half. A start that names a harness conversation
 * REQUIRES its transcript: Conversation (the stage owner, a fake here) copies a host-only transcript into the harness's
 * pool before the launch, and a conversation that cannot be staged refuses the start. The fake harness is HONEST
 * (`honestHistory`): it proves a conversation absent until it is staged, as a real harness's `hasConversation` does.
 */

const ORIGINAL = 'conversation-existing';

/** The owner's own computer holds `hostOnly`; staging one copies it into the harness's pool (`Harness.importConversation`). */
const stageOwner = (
  harness: FakeHarness,
  hostOnly: readonly string[],
  asked: string[] = [],
): ConversationStageSource => ({
  stage: async ({ conversation }) => {
    asked.push(conversation);
    if (!hostOnly.includes(conversation))
      return err({ code: 'not_found', reason: `No conversation ${conversation} is on this machine.` });
    const copied = await harness.importConversation({
      id: conversation,
      source: `projects/-work-a/${conversation}.jsonl`,
    });
    return copied.ok ? ok(undefined) : err({ code: 'failed', reason: copied.error.reason });
  },
});

test('R-0332 a start accepts and preserves the harness conversation approved by the launch contract', async () => {
  const runner = new FakeRunner();
  const harness = new FakeHarness().honestHistory();
  const h = await host([], { harness, runner, plugins: [fakeStageOwner(stageOwner(harness, [ORIGINAL]))] });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'conversation' },
    body: { folder: '/work/a', harnessConversation: ORIGINAL },
  });
  expect(started.status).toBe(201);
  const id = started.json<{ id: string }>().id;
  expect(JSON.parse(h.state('ferrets').raw(FerretFiles, id) ?? '{}')).toMatchObject({
    harnessConversation: ORIGINAL,
  });
  // O8-12: this is the one path "Continue a past conversation" uses; the harness is asked to RESUME that conversation.
  expect(harness.resumed).toEqual([ORIGINAL]);
  for (const harnessConversation of ['', 'c'.repeat(257)]) {
    const answer = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'invalid-conversation' },
      body: { folder: '/work/a', harnessConversation },
    });
    expect(answer.status).toBe(400);
  }
  expect(runner.starts).toBe(1);
});

// The same proof for both harnesses: the host-only transcript is unstaged, and the runner must get the ORIGINAL id.
describe.each(['claude-code', 'codex'] as const satisfies readonly HarnessKey[])('continuing on %s', key => {
  const world = async (hostOnly: readonly string[], asked: string[] = []) => {
    const runner = new FakeRunner();
    const harness = new FakeHarness(key).honestHistory();
    const h = await host([], { harness, runner, plugins: [fakeStageOwner(stageOwner(harness, hostOnly, asked))] });
    return { runner, harness, h };
  };
  const start = (h: Awaited<ReturnType<typeof world>>['h'], conversation: string) =>
    h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': `continue-${conversation}` },
      body: { folder: '/work/a', harness: key, harnessConversation: conversation },
    });

  test('an unstaged host-only transcript is staged first, and the runner gets the ORIGINAL conversation id', async () => {
    const asked: string[] = [];
    const { runner, harness, h } = await world([ORIGINAL], asked);
    expect(harness.pool.has(ORIGINAL)).toBe(false);
    const started = await start(h, ORIGINAL);
    expect(started.status).toBe(201);
    expect(asked).toEqual([ORIGINAL]);
    expect(harness.imported.map(copy => copy.id)).toEqual([ORIGINAL]);
    // The harness resumed the conversation that was picked, never a fresh one (`conv-<ferret>`), and the record keeps it.
    expect(harness.resumed).toEqual([ORIGINAL]);
    expect(runner.starts).toBe(1);
    const id = started.json<{ id: string }>().id;
    expect(JSON.parse(h.state('ferrets').raw(FerretFiles, id) ?? '{}')).toMatchObject({
      harnessConversation: ORIGINAL,
    });
  });

  test('a conversation this machine does not hold refuses the start with its reason: nothing is launched, nothing is written', async () => {
    const { runner, harness, h } = await world([]);
    const refused = await start(h, 'conversation-missing');
    expect(refused.status).toBe(409);
    expect(refused.json<{ error: string }>().error).toContain(
      'No conversation conversation-missing is on this machine.',
    );
    expect(runner.starts).toBe(0);
    expect(harness.launched).toEqual([]);
    const listed = await h.request('GET', '/v1/ferrets');
    expect(listed.json<readonly unknown[]>()).toEqual([]);
  });

  test('a transcript the harness still proves absent after staging refuses the start; it is never a silent fresh start', async () => {
    const { runner, harness, h } = await world([ORIGINAL]);
    // Staging says yes, but the harness's own home still does not have it (a copy that landed where it cannot find it).
    harness.importConversation = async () => ok(undefined);
    const refused = await start(h, ORIGINAL);
    expect(refused.status).toBe(409);
    expect(refused.json<{ error: string }>().error).toContain(`conversation ${ORIGINAL} was not found`);
    expect(runner.starts).toBe(0);
    expect(harness.resumed).toEqual([]);
    expect(harness.launched.every(spec => spec.harnessConversation === ORIGINAL)).toBe(true);
  });
});

// E17: Conversation off means nothing can be COPIED in, not that nothing can be resumed. An adoption of a transcript the
// pool already holds needs no staging; one the harness proves absent is still refused, never started fresh.
test('with no conversation index on the host, a transcript the pool already holds is resumed', async () => {
  const runner = new FakeRunner();
  const harness = new FakeHarness().honestHistory();
  harness.pool.add(ORIGINAL);
  const h = await host([], { harness, runner });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'no-index-pooled' },
    body: { folder: '/work/a', harnessConversation: ORIGINAL },
  });
  expect(started.status).toBe(201);
  expect(harness.imported).toEqual([]);
  expect(harness.resumed).toEqual([ORIGINAL]);
  expect(runner.starts).toBe(1);
});

test('with no conversation index on the host, a transcript the harness proves absent is refused, not started fresh', async () => {
  const runner = new FakeRunner();
  const harness = new FakeHarness().honestHistory();
  const h = await host([], { harness, runner });
  const refused = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'no-index' },
    body: { folder: '/work/a', harnessConversation: ORIGINAL },
  });
  expect(refused.status).toBe(409);
  const said = refused.json<{ error: string }>().error;
  expect(said).toContain(`conversation ${ORIGINAL} was not found`);
  expect(said).toContain('only while the Conversations plugin is on');
  expect(runner.starts).toBe(0);
  expect(harness.resumed).toEqual([]);
});

test('a stage owner that throws refuses the start in one plain sentence: nothing is launched', async () => {
  const runner = new FakeRunner();
  const harness = new FakeHarness().honestHistory();
  const h = await host([], {
    harness,
    runner,
    plugins: [
      fakeStageOwner({
        stage: async () => {
          throw new Error('the index is unreadable');
        },
      }),
    ],
  });
  const refused = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'stage-throws' },
    body: { folder: '/work/a', harnessConversation: ORIGINAL },
  });
  expect(refused.status).toBe(409);
  expect(refused.json<{ error: string }>().error).toContain('the conversation could not be staged');
  expect(runner.starts).toBe(0);
});

test('only the OWNER’s start stages a host transcript: a ferret naming one pulls nothing into the pool and is refused', async () => {
  const asked: string[] = [];
  const runner = new FakeRunner();
  const harness = new FakeHarness().honestHistory();
  const plain = await host([record('lead')], {
    harness,
    runner,
    // A ferret's start is a helper's: Packs must admit it (ruling #43), so a stand-in Packs says yes.
    plugins: [fakeStageOwner(stageOwner(harness, [ORIGINAL], asked)), fakePacks().plugin],
  });
  // Readable (empty) credential state, so a start can issue the helper's token.
  plain.state('ferrets').plant(FerretTokensFile, JSON.stringify({ format: 1, tokens: [] }));
  const h = await plain.restart();
  const refused = await h.request('POST', '/v1/ferrets', {
    ...as('lead'),
    headers: { ...as('lead').headers, 'x-fy-request-id': 'ferret-continue' },
    body: { folder: '/work/lead', harnessConversation: ORIGINAL },
  });
  expect(refused.status).toBe(409);
  expect(refused.json<{ error: string }>().error).toContain(`conversation ${ORIGINAL} was not found`);
  expect(asked, 'the stage owner was never asked on a ferret’s behalf').toEqual([]);
  expect(harness.imported).toEqual([]);
  expect(runner.starts).toBe(0);
});

test('a start that names no conversation never asks the stage owner', async () => {
  const asked: string[] = [];
  const runner = new FakeRunner();
  const harness = new FakeHarness().honestHistory();
  const h = await host([], { harness, runner, plugins: [fakeStageOwner(stageOwner(harness, [], asked))] });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'fresh' },
    body: { folder: '/work/a' },
  });
  expect(started.status).toBe(201);
  expect(asked).toEqual([]);
  expect(harness.resumed).toEqual([]);
});
