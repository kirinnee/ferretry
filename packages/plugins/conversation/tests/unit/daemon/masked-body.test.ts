import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { jsonResponse, type Redaction, textResponse } from '@ferretry/kernel/contract';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import { CONVERSATION_STATE, ConversationPort } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { maskedBody } from '../../../daemon/seams/masked-body.ts';
import { memoryStatePort } from '../../support/state.ts';

const SECRET = 'sk-live-77aa';
const hiding: Redaction = {
  read: async fn => await fn({ text: s => s.split(SECRET).join('[redacted]'), lines: l => l, cells: g => g }),
};
const call = {} as never;

describe('maskedBody', () => {
  test('masks every string of a JSON answer, built inside the read, and keeps bytes and digests', async () => {
    let inside = false;
    const redaction: Redaction = {
      read: async fn => {
        inside = true;
        try {
          return await hiding.read(fn);
        } finally {
          inside = false;
        }
      },
    };
    let builtInside = false;
    const route = maskedBody(redaction, async () => {
      builtInside = inside;
      return jsonResponse({
        messages: [{ text: `use ${SECRET} now`, base64: SECRET, sha256: SECRET }],
        count: 1,
      });
    });
    const response = await route(call);
    expect(builtInside).toBe(true);
    expect(JSON.parse(response.body)).toEqual({
      messages: [{ text: 'use [redacted] now', base64: SECRET, sha256: SECRET }],
      count: 1,
    });
  });

  test('a redaction that cannot open fails the route closed', async () => {
    const broken: Redaction = {
      read: async () => {
        throw new Error('the vault will not open');
      },
    };
    await expect(maskedBody(broken, async () => jsonResponse({ text: SECRET }))(call)).rejects.toThrow(
      'the vault will not open',
    );
  });

  test('an answer that is not JSON passes as it was built', async () => {
    const response = await maskedBody(hiding, async () => textResponse(`raw ${SECRET}`))(call);
    expect(response.body).toBe(`raw ${SECRET}`);
  });
});

/**
 * The real daemon half on a test host that knows {@link SECRET} as a secret. Every call is stamped as the owner's CLI
 * (`admin-cli`), as Gate would: the test host's admission stamps no actor, and a draft is the owner's only.
 */
async function ownersConversation() {
  const ferrets = new FakeFerrets();
  const F1 = ferretId('f1');
  ferrets.add({ id: F1 });
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      const half = build({ ...ctx, kernel: { ...ctx.kernel, state: memoryStatePort(CONVERSATION_STATE) } });
      const routes = Object.fromEntries(
        Object.entries(half.routes ?? {}).map(([key, handler]) => [
          key,
          (call: Parameters<typeof handler>[0]) => handler({ ...call, actor: 'admin-cli' } as typeof call),
        ]),
      );
      return { ...half, routes } as typeof half;
    },
  } as typeof daemon;
  return await testHost({
    plugins: [implementation],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-07T09:00:00Z'),
    secrets: [SECRET],
  });
}

describe("the owner's shared draft is served raw, so its positional edits land where they were made", () => {
  test('a draft holding a known secret reads back raw on GET and POST, and the next edit counts from the raw text', async () => {
    const host = await ownersConversation();
    type Snapshot = { generation: string; epoch: number; rev: number; text: string };
    const empty = await host.request('GET', '/v1/ferrets/f1/shared-draft', { as: owner() });
    expect(empty.status).toBe(200);
    const start = empty.json<Snapshot>();
    const typed = `pw ${SECRET}`;
    const first = await host.request('POST', '/v1/ferrets/f1/shared-draft', {
      as: owner(),
      body: { generation: start.generation, epoch: start.epoch, base: start.rev, text: [typed] },
    });
    expect(first.status).toBe(200);
    const afterFirst = first.json<{ snapshot: Snapshot }>().snapshot;
    expect(afterFirst.text).toBe(typed);
    // A composer seeded from GET counts its retain over the raw text; a masked GET would put " ok" somewhere else.
    const seeded = (await host.request('GET', '/v1/ferrets/f1/shared-draft', { as: owner() })).json<Snapshot>();
    expect(seeded.text).toBe(typed);
    const second = await host.request('POST', '/v1/ferrets/f1/shared-draft', {
      as: owner(),
      body: { generation: seeded.generation, epoch: seeded.epoch, base: seeded.rev, text: [seeded.text.length, ' ok'] },
    });
    expect(second.status).toBe(200);
    expect(second.json<{ snapshot: Snapshot }>().snapshot.text).toBe(`${typed} ok`);
    await host.stop();
  });
});

describe('the daemon masks its secrets-guarded answers', () => {
  test('an attachment named with a pasted secret is served masked, its bytes untouched', async () => {
    const ferrets = new FakeFerrets();
    const F1 = ferretId('f1');
    ferrets.add({ id: F1 });
    const implementation = {
      ...daemon,
      build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
        const build = daemon.build;
        if (build === undefined) throw new Error('the conversation daemon half has no build');
        return build({ ...ctx, kernel: { ...ctx.kernel, state: memoryStatePort(CONVERSATION_STATE) } });
      },
    } as typeof daemon;
    const host = await testHost({
      plugins: [implementation],
      fakes: { ferrets, asks: new FakeAsks() },
      clock: fixedClock('2026-11-07T09:00:00Z'),
      secrets: [SECRET],
    });
    const bytes = Buffer.from(`notes about ${SECRET}`).toString('base64');
    const added = await host
      .provided(ConversationPort)
      .addAttachment(F1, { filename: `${SECRET}.txt`, mime: 'text/plain', base64: bytes });
    if (!added.ok) throw new Error(added.error.message);
    const response = await host.request('GET', `/v1/ferrets/f1/attachments/${added.value.id}`, { as: owner() });
    expect(response.status).toBe(200);
    const body = response.json<{ attachment: { filename: string }; base64: string }>();
    expect(body.attachment.filename).toBe(`${'*'.repeat(SECRET.length)}.txt`);
    expect(body.base64).toBe(bytes);
    await host.stop();
  });
});
