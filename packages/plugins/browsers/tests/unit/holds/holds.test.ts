import { describe, expect, test } from 'bun:test';
import { type Content, type Picture, type SecretName, secretMask, targetRef } from '@ferretry/core-vault/contract';
import { FakeInputHolds, FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { Redaction } from '@ferretry/kernel/contract';
import { TestMintedIds, testActRunner } from '@ferretry/kernel/testing';
import {
  actOnPage,
  heldOrMasked,
  holdSentence,
  PageHeld,
  pageHoldTarget,
  WITHHELD_FAILURE,
} from '../../../daemon/holds/index.ts';
import { siteOf } from '../../../daemon/holds/site.ts';

const SECRET = 'hunter2-the-value';
const PAGE = { id: 'pg-1', reference: '%browser:app' };

function kernel(redaction: Redaction = new FakeRedaction(new Map([['PW' as SecretName, SECRET]]))) {
  const holds = new FakeInputHolds();
  return {
    holds,
    ports: {
      act: testActRunner({ holds: () => holds, actor: () => 'ferret', minted: new TestMintedIds() }),
      redaction,
    },
  };
}

const TEXT: Content = { kind: 'content', text: 'Welcome' };
const PNG: Picture = { kind: 'picture', mime: 'image/png', bytes: new Uint8Array([1]) };

describe('page hold targets', () => {
  test('I121 a page is held by its own kind and the daemon id, never by a terminal of the same name', () => {
    expect(pageHoldTarget('app')).toEqual(targetRef('page', 'app'));
    expect(pageHoldTarget('app')).not.toEqual(targetRef('terminal', 'app'));
  });

  test('I121 a quarantined terminal named like a page leaves the page readable', async () => {
    const { holds, ports } = kernel();
    holds.quarantine(targetRef('terminal', 'pg-1'));
    expect(await actOnPage(ports.act, PAGE, 'read', 'agent', async () => TEXT)).toEqual(TEXT);
  });
});

describe('acts on a held page, by effect', () => {
  test('I116 a page hold refuses every picture for its whole window, after the page moved on too', async () => {
    for (const onHeldDocument of [true, false]) {
      const { holds, ports } = kernel();
      holds.pageHold(pageHoldTarget(PAGE.id), { onHeldDocument });
      let pictured = false;
      const act = actOnPage(ports.act, PAGE, 'picture', 'agent', async () => {
        pictured = true;
        return PNG;
      });
      await expect(act).rejects.toBeInstanceOf(PageHeld);
      expect(pictured).toBe(false);
    }
  });

  test('I116 an until-moved-on hold lets pictures back once the page left the document', async () => {
    const { holds, ports } = kernel();
    holds.pageHold(pageHoldTarget(PAGE.id), { onHeldDocument: false, untilMovedOn: true });
    expect(await actOnPage(ports.act, PAGE, 'picture', 'agent', async () => PNG)).toEqual(PNG);
  });

  test('I117 every reading op, script included, is refused while the held document shows', async () => {
    for (const op of ['read', 'wait', 'script'] as const) {
      const { holds, ports } = kernel();
      holds.pageHold(pageHoldTarget(PAGE.id), { onHeldDocument: true });
      await expect(actOnPage(ports.act, PAGE, op, 'agent', async () => TEXT)).rejects.toThrow(
        "%browser:app is held: the owner's secret was just typed there",
      );
    }
  });

  test('I117 after a new document the read runs (masked by the reader), the hold no longer refuses it', async () => {
    const { holds, ports } = kernel();
    holds.pageHold(pageHoldTarget(PAGE.id), { onHeldDocument: false });
    expect(await actOnPage(ports.act, PAGE, 'script', 'agent', async () => TEXT)).toEqual(TEXT);
  });

  test('I118 a pending non-code card refuses a key press and a script on the page; code-only lets neither through', async () => {
    for (const codeOnly of [false, true]) {
      for (const op of ['press', 'script'] as const) {
        const { holds, ports } = kernel();
        holds.pendingCard(pageHoldTarget(PAGE.id), { codeOnly });
        await expect(
          actOnPage(ports.act, PAGE, op, 'agent', async () => (op === 'press' ? { status: 'done' } : TEXT)),
        ).rejects.toBeInstanceOf(PageHeld);
      }
    }
  });

  test('a refusal is worded for who asked', () => {
    expect(holdSentence('held', '%browser:app', 'person')).toBe(
      '%browser:app is held: a secret was just typed there. Look at it in the browser view, or try again shortly.',
    );
    expect(holdSentence('input_pending', '%browser:app', 'agent')).toContain('do not type there yourself');
    expect(holdSentence('target_gone', '%browser:app', 'agent')).toBe('That target is no longer open.');
  });
});

describe('a failed call under a hold', () => {
  test('I120 a read that failed while a hold began answers with the hold, success or not', async () => {
    const { holds, ports } = kernel();
    holds.pageHold(pageHoldTarget(PAGE.id), { onHeldDocument: true });
    const out = await heldOrMasked(ports, PAGE, 'read', 'agent', new Error(`the page threw ${SECRET}`));
    expect(out).toBeInstanceOf(PageHeld);
    expect(out.message).not.toContain(SECRET);
  });

  test('I120 any other message passes the redactor', async () => {
    const { ports } = kernel();
    const out = await heldOrMasked(ports, PAGE, 'read', 'agent', new Error(`the page threw ${SECRET}`));
    expect(out.message).toBe(`the page threw ${secretMask('PW' as SecretName)}`);
  });

  test('I120 a redactor that cannot run fails closed to a fixed sentence', async () => {
    const broken: Redaction = {
      read: async () => {
        throw new Error('the store is locked');
      },
    };
    const { ports } = kernel(broken);
    const out = await heldOrMasked(ports, PAGE, 'read', 'agent', new Error(`the page threw ${SECRET}`));
    expect(out.message).toBe(WITHHELD_FAILURE);
  });

  test('I120 a hold check that is unavailable answers as a hold, never the message', async () => {
    const out = await heldOrMasked(
      {
        act: testActRunner({ holds: () => undefined, actor: () => 'ferret', minted: new TestMintedIds() }),
        redaction: new FakeRedaction(new Map()),
      },
      PAGE,
      'read',
      'agent',
      new Error(`the page threw ${SECRET}`),
    );
    expect(out).toBeInstanceOf(PageHeld);
    expect((out as PageHeld).code).toBe('holds_unavailable');
  });
});

describe('the site a host belongs to', () => {
  test('I97 hosts group by their last two labels, port dropped, never narrower than the registrable domain', () => {
    expect(siteOf('mail.example.com')).toBe('example.com');
    expect(siteOf('accounts.example.com:8443')).toBe('example.com');
    expect(siteOf('Example.COM')).toBe('example.com');
    expect(siteOf('a.b.example.co.uk')).toBe('co.uk');
  });

  test('I97 an IP address or a one-label host is its own site', () => {
    expect(siteOf('127.0.0.1:3000')).toBe('127.0.0.1');
    expect(siteOf('[::1]:8080')).toBe('[::1]');
    expect(siteOf('localhost')).toBe('localhost');
  });
});
