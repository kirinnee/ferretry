/**
 * The owner's "Allow paste" card (docs/secure-copy.md): a ferret asks to paste a secure copy it holds. There is no field.
 * The owner reads WHAT is pasted (the handle), WHERE it was read and WHERE it goes, and allows or cancels; the body that
 * leaves is `{ sealed: true }`, which names no copy and no value. The only value-shaped string here is the obvious fake.
 */
import { describe, expect, it } from 'bun:test';
import { InputCard } from '../../../app/features/input/input-card.tsx';
import { inputFailure, pasteRoute, sealedBody, titleWords } from '../../../app/lib/input-card.ts';
import { InputRequestViewSchema } from '../../../app/lib/input-wire.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { mount, must } from '../../support/app/dom.ts';
import {
  COPY_SOURCE,
  pageRequest,
  pasteRequest,
  REQUEST_ID,
  recordingClient,
  terminalRequest,
} from '../../support/app/input-fixtures.ts';

const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const DELIVERED = { id: REQUEST_ID, state: 'delivered', submitted: true };
const SENTINEL = 'FAKE-SC-7f3a91';

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);

async function card(request = pasteRequest(), answer?: () => Promise<unknown>, refreshed: string[] = []) {
  const rig = recordingClient(async route => {
    if (route.endsWith('/deliver')) return answer === undefined ? DELIVERED : await answer();
    return {};
  });
  const done: string[] = [];
  const mounted = await mount(
    <InputCard
      client={rig.client}
      now={NOW}
      onDone={() => done.push('done')}
      onRefresh={() => refreshed.push('refresh')}
      request={request}
    />,
  );
  await settle();
  return { ...rig, mounted, done };
}

describe('the paste card’s words', () => {
  it('should read a paste request’s source, which the app used to ignore', () => {
    const read = InputRequestViewSchema.safeParse(pasteRequest());

    expect(read.success).toBe(true);
    expect(read.success && read.data.source).toMatchObject({ kind: 'sealed', name: 'vercel' });
  });

  it('should title a paste as a paste and an ordinary card as what it needs', () => {
    expect(titleWords(pasteRequest(), 'Hadi')).toBe('!A7 · Hadi wants to paste a sealed value');
    expect(titleWords(terminalRequest(), 'Hadi')).toBe('!A7 · Hadi needs a password');
  });

  it('should say where a copy came from and where it goes, from what the daemon saw', () => {
    expect(pasteRoute(pasteRequest())).toEqual({
      from: '/usr/bin/vercel (what it printed)',
      to: 'sudo in %terminal:dev',
    });
    expect(
      pasteRoute(
        pasteRequest({
          target: { kind: 'page', key: 'app' },
          observed: pageRequest().observed,
          source: { ...COPY_SOURCE, from: { kind: 'browser', origin: 'https://vercel.com' } },
        }),
      ),
    ).toEqual({ from: 'https://vercel.com', to: 'a field on https://example.test' });
    expect(
      pasteRoute(
        pasteRequest({
          target: { kind: 'secret', key: 'VERCEL_TOKEN' },
          observed: { kind: 'secret', name: 'VERCEL_TOKEN', exists: true },
        }),
      )?.to,
    ).toBe('the secret VERCEL_TOKEN (replacing its value)');
    expect(pasteRoute(terminalRequest())).toBeUndefined();
  });

  it('should send only that the owner allows it: no copy named, no value, the digest the owner saw', () => {
    const built = sealedBody(pasteRequest(), false, 'delivery-1');

    expect(built).toEqual({
      ok: true,
      body: { deliveryId: 'delivery-1', observedDigest: 'b'.repeat(64), sealed: true, submit: false },
    });
    expect(sealedBody(pasteRequest({ observedDigest: undefined }), false, 'delivery-2').ok).toBe(false);
  });
});

describe('the paste card', () => {
  it('should show the copy, where it came from and where it goes, with no field and an Allow paste button', async () => {
    const { mounted } = await card();
    try {
      const root = mounted.container;

      expect(q(root, '[data-input-paste-copy]').textContent).toBe('sealed:vercel');
      expect(q(root, '[data-input-paste-from]').textContent).toBe('/usr/bin/vercel (what it printed)');
      expect(q(root, '[data-input-paste-to]').textContent).toBe('sudo in %terminal:dev');
      expect(root.textContent).toContain('You type nothing');
      expect(root.querySelector('[data-input-value]')).toBeNull();
      expect(root.querySelector('[data-input-send]')).toBeNull();
      expect(q(root, '[data-input-title]').textContent).toBe('!A7 · The ferret wants to paste a sealed value');
      expect(q<HTMLButtonElement>(root, '[data-input-allow]').textContent).toBe('Allow paste');
      expect(root.textContent).not.toContain('Answer it with fy');
    } finally {
      await mounted.unmount();
    }
  });

  it('should allow the paste with a sealed body that carries no value, and settle in words', async () => {
    const { mounted, calls, done } = await card();
    try {
      await click(q(mounted.container, '[data-input-allow]'));
      await settle();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.route).toContain('/deliver');
      expect(calls[0]?.init?.body).toMatchObject({ sealed: true, observedDigest: 'b'.repeat(64) });
      expect(Object.keys(calls[0]?.init?.body as object).sort()).toEqual([
        'deliveryId',
        'observedDigest',
        'sealed',
        'submit',
      ]);
      expect(JSON.stringify(calls)).not.toContain(SENTINEL);
      expect(mounted.container.textContent).toContain('Pasted into %terminal:dev.');
      expect(mounted.container.querySelector('[data-input-allow]')).toBeNull();
      expect(done).toEqual(['done']);
    } finally {
      await mounted.unmount();
    }
  });

  it('should settle the card when the daemon ends the paste for good (a takeover): say why, refresh, and take Allow away', async () => {
    const refreshed: string[] = [];
    const { mounted, done } = await card(
      pasteRequest({ target: { kind: 'page', key: 'app' }, observed: pageRequest().observed }),
      async () => {
        throw {
          status: 409,
          code: 'taken_over',
          message: 'A person has taken over that page, so nothing is pasted into it.',
        };
      },
      refreshed,
    );
    try {
      await click(q(mounted.container, '[data-input-allow]'));
      await settle();

      expect(q(mounted.container, '[data-input-failure]').textContent).toBe(
        'A person has taken over that page, so nothing is pasted into it.',
      );
      expect(q(mounted.container, '[data-input-ended]').textContent).toContain('Nothing was pasted');
      expect(mounted.container.querySelector('[data-input-allow]')).toBeNull();
      expect(refreshed).toEqual(['refresh']);
      expect(done).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });

  it('should settle the card the same way when its copy is gone (discarded, expired or captured again)', async () => {
    const refreshed: string[] = [];
    const { mounted } = await card(
      pasteRequest(),
      async () => {
        throw {
          status: 410,
          code: 'gone',
          message: 'sealed:vercel was discarded or expired, so there is nothing to paste',
        };
      },
      refreshed,
    );
    try {
      await click(q(mounted.container, '[data-input-allow]'));
      await settle();

      expect(mounted.container.querySelector('[data-input-allow]')).toBeNull();
      expect(q(mounted.container, '[data-input-ended]')).not.toBeNull();
      expect(refreshed).toEqual(['refresh']);
    } finally {
      await mounted.unmount();
    }
  });

  it('should keep the card for another try when the refusal is only a changed target', async () => {
    const refreshed: string[] = [];
    const { mounted } = await card(
      pasteRequest(),
      async () => {
        throw { status: 409, code: 'target_changed', message: 'moved' };
      },
      refreshed,
    );
    try {
      await click(q(mounted.container, '[data-input-allow]'));
      await settle();

      expect(mounted.container.querySelector('[data-input-ended]')).toBeNull();
      expect(q<HTMLButtonElement>(mounted.container, '[data-input-allow]').disabled).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('should keep Allow off while the daemon looks at the target again, and cancel from the card', async () => {
    const { mounted, calls } = await card(pasteRequest({ observed: undefined, observedDigest: undefined }));
    try {
      expect(q<HTMLButtonElement>(mounted.container, '[data-input-allow]').disabled).toBe(true);
      expect(mounted.container.querySelector('[data-input-observing]')).not.toBeNull();

      await click(q(mounted.container, '[data-input-cancel]'));
      await settle();

      expect(calls.map(call => call.route)).toEqual([expect.stringContaining('/cancel')]);
      expect(mounted.container.textContent).toContain('Cancelled. Nothing was typed.');
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the paste card tells what the daemon saw (secure-clip-1 fix1, P3-9)', () => {
  it('should show a safe length and the kind of source, never a sample of the value', async () => {
    const { mounted } = await card();
    try {
      expect(q(mounted.container, '[data-input-paste-size]').textContent).toBe(
        '40 characters · what a command printed',
      );
      expect(mounted.container.textContent).not.toContain(SENTINEL);
    } finally {
      await mounted.unmount();
    }
    const page = pasteRequest({ source: { ...COPY_SOURCE, from: { kind: 'browser', origin: 'https://vercel.com' } } });
    const other = await card(page);
    try {
      expect(q(other.mounted.container, '[data-input-paste-size]').textContent).toBe(
        '40 characters · text read from a page',
      );
    } finally {
      await other.mounted.unmount();
    }
  });

  it('should show the field a page paste goes into: its observed type and name, and the ferret’s own label apart', async () => {
    const observed = pageRequest().observed as unknown as { fields: { field: Record<string, unknown> }[] };
    const request = pasteRequest({
      target: { kind: 'page', key: 'app' },
      fields: [{ id: 'value', label: 'Vercel token', sensitivity: 'secret' }],
      observed: {
        ...observed,
        fields: [{ ...observed.fields[0], field: { tag: 'input', type: 'password', name: 'api_token' } }],
      },
    });
    const { mounted } = await card(request);
    try {
      const said = q(mounted.container, '[data-input-paste-field]').textContent;
      expect(said).toContain('password field');
      expect(said).toContain('api_token');
      expect(said).toContain('The ferret calls it “Vercel token”');
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the paste card’s layout and weight (secure-clip-1 fix1, P2-6, P3-10)', () => {
  const replacing = () =>
    pasteRequest({
      target: { kind: 'secret', key: 'VERCEL_TOKEN' },
      observed: { kind: 'secret', name: 'VERCEL_TOKEN', exists: true },
      risk: { level: 'amber', reason: 'This replaces the value the secret holds now; the old value is gone for good.' },
    });

  it('should make replacing a secret loud and its approval destructive', async () => {
    const { mounted } = await card(replacing());
    try {
      expect(q(mounted.container, '[data-input-replace]').textContent).toContain('gone for good');
      const allow = q<HTMLButtonElement>(mounted.container, '[data-input-allow]');
      expect(allow.dataset.variant).toBe('danger');
      expect(allow.textContent).toBe('Replace secret');
    } finally {
      await mounted.unmount();
    }
  });

  it('should keep the ordinary approval for a new secret or any other paste', async () => {
    const fresh = await card(
      pasteRequest({
        target: { kind: 'secret', key: 'NEW_TOKEN' },
        observed: { kind: 'secret', name: 'NEW_TOKEN', exists: false },
      }),
    );
    try {
      expect(fresh.mounted.container.querySelector('[data-input-replace]')).toBeNull();
      const allow = q<HTMLButtonElement>(fresh.mounted.container, '[data-input-allow]');
      expect(allow.dataset.variant).toBe('primary');
      expect(allow.textContent).toBe('Allow paste');
    } finally {
      await fresh.mounted.unmount();
    }
  });

  it('should keep the time left beside the title, not on a line of its own', async () => {
    const { mounted } = await card();
    try {
      const header = q(mounted.container, 'header');
      expect(header.className).not.toContain('flex-wrap');
      expect(q(mounted.container, '[data-input-expiry]').className).toContain('shrink-0');
    } finally {
      await mounted.unmount();
    }
  });

  it('should give one hidden-typing hint: the generic green risk line is not repeated on a paste card', async () => {
    const quiet = pasteRequest({
      risk: { level: 'green', reason: 'Typing is hidden here, and the ferret never sees the value.' },
    });
    const { mounted } = await card(quiet);
    try {
      expect(mounted.container.querySelector('[data-input-risk="green"]')).toBeNull();
      expect(mounted.container.textContent).toContain('You type nothing');
      expect(mounted.container.textContent).not.toContain('Typing is hidden here');
    } finally {
      await mounted.unmount();
    }
    const flagged = pasteRequest({
      risk: {
        level: 'amber',
        reason: 'The ferret saw this value before it was sealed, so it is not protected; consider rotating it.',
      },
    });
    const loud = await card(flagged);
    try {
      expect(q(loud.mounted.container, '[data-input-risk="amber"]').textContent).toContain('not protected');
    } finally {
      await loud.mounted.unmount();
    }
  });

  it('should show an amber could-not-check risk as a visible warning, not footer help (secure-clip-1 fix2, R2)', async () => {
    const { mounted } = await card(
      pasteRequest({
        risk: {
          level: 'amber',
          reason: 'The ferret may have read this value on the page before it was sealed, so it may not be protected.',
        },
      }),
    );
    try {
      const warning = q(mounted.container, '[data-input-warning]');
      expect(warning.getAttribute('data-input-risk')).toBe('amber');
      expect(warning.textContent).toContain('may not be protected');
      expect(warning.className).toContain('border-warn');
      expect(warning.className).not.toContain('text-muted');
      expect(warning.getAttribute('role')).toBe('status');
    } finally {
      await mounted.unmount();
    }
  });

  it('should keep a green or replace risk out of the warning treatment', async () => {
    const replacing = await card(
      pasteRequest({
        target: { kind: 'secret', key: 'VERCEL_TOKEN' },
        observed: { kind: 'secret', name: 'VERCEL_TOKEN', exists: true },
        risk: {
          level: 'amber',
          reason: 'This replaces the value the secret holds now; the old value is gone for good.',
        },
      }),
    );
    try {
      expect(replacing.mounted.container.querySelector('[data-input-warning]')).toBeNull();
      expect(q(replacing.mounted.container, '[data-input-replace]')).not.toBeNull();
    } finally {
      await replacing.mounted.unmount();
    }
  });

  it('should stop counting down once a takeover ended the paste, before any refresh arrives (secure-clip-1 fix2, R3)', async () => {
    const { mounted } = await card(
      pasteRequest({ target: { kind: 'page', key: 'app' }, observed: pageRequest().observed }),
      async () => {
        throw { status: 409, code: 'taken_over', message: 'A person has taken over that page.' };
      },
    );
    try {
      expect(q(mounted.container, '[data-input-expiry]').textContent).toContain('left');
      await click(q(mounted.container, '[data-input-allow]'));
      await settle();

      expect(q(mounted.container, '[data-input-ended]')).not.toBeNull();
      const header = q(mounted.container, '[data-input-expiry]').textContent ?? '';
      expect(header).toBe('ended');
      expect(header).not.toContain('left');
    } finally {
      await mounted.unmount();
    }
  });

  it('should stop counting down when its copy is gone, and when the daemon already reports the request final', async () => {
    const gone = await card(pasteRequest(), async () => {
      throw {
        status: 410,
        code: 'gone',
        message: 'sealed:vercel was discarded or expired, so there is nothing to paste',
      };
    });
    try {
      await click(q(gone.mounted.container, '[data-input-allow]'));
      await settle();
      expect(q(gone.mounted.container, '[data-input-expiry]').textContent).toBe('ended');
    } finally {
      await gone.mounted.unmount();
    }
    for (const state of ['refused', 'cancelled', 'delivered'] as const) {
      const final = await card(pasteRequest({ state }));
      try {
        expect(q(final.mounted.container, '[data-input-expiry]').textContent).toBe('ended');
      } finally {
        await final.mounted.unmount();
      }
    }
  });

  it('should read a takeover and a gone copy as final, and a changed target as retryable', () => {
    expect(inputFailure({ status: 409, code: 'taken_over', message: 'A person took it.' }, 'page')).toMatchObject({
      kind: 'ended',
      definitive: true,
      text: 'A person took it.',
    });
    expect(inputFailure({ status: 410, code: 'gone', message: 'x' }, 'page').kind).toBe('gone');
    expect(inputFailure({ status: 409, code: 'target_changed' }, 'page').kind).toBe('changed');
  });
});
