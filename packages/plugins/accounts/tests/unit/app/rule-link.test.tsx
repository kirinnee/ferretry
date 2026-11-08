/**
 * THE `#rules/<stage>` LINK `fy rules add` PRINTS (shell contract S3, MA2): the shell's real fragment taker strips it and
 * hands it whole to Accounts' device view, which sends the page to one machine's Secure copy tab; that machine's list
 * highlights the row once it has read the daemon's list (v4's `useRuleDeepLink` and the panel's read, unchanged in what
 * the owner sees). Every link here is built by the real `ruleDeepLink`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { DaemonReach } from '@ferretry/app';
import {
  deviceViewHarness,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  noteClientDaemon,
  RouterProvider,
} from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { RULE_FRAGMENT_KEY, ruleLinkView } from '../../../app/features/secure-copy/rule-link-view.tsx';
import { SignInRulesSurface } from '../../../app/features/secure-copy/sign-in-rules-surface.tsx';
import half from '../../../app/index.ts';
import { RULE_LINKED_ELSEWHERE_WORDS, RULE_LINKED_STAGE_GONE_WORDS, RuleLinkHold } from '../../../app/lib/rule-link.ts';
import { ruleDeepLink, ruleDeepLinkFromFragment } from '../../../contract/routes/index.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { ruleClient } from '../../support/app/sign-in-rule-client.ts';
import { machineStage, ruleList, STAGE_ID } from '../../support/app/sign-in-rule-fixtures.ts';

const ORIGIN = 'https://app.example';
const A = `fy_daemon_${'a'.repeat(43)}`;
const B = `fy_daemon_${'b'.repeat(43)}`;
const C = `fy_daemon_${'c'.repeat(43)}`;
const OTHER_STAGE = `srs_${'e'.repeat(24)}` as typeof STAGE_ID;

const row = (daemon: string): DaemonReach => fakeReachRow({ daemon, client: {} as PluginClient });
const secureCopy = (daemon: string): string => `/d/${daemon}/settings/accounts/secure-copy`;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.history.replaceState(null, '', '/');
});

async function open(href: string, rows: readonly DaemonReach[], wrap: (node: ReactNode) => ReactNode = node => node) {
  const harness = deviceViewHarness({ plugin: 'accounts', fragments: half.shell.fragments ?? [], href });
  harness.setRows(rows);
  const hold = new RuleLinkHold();
  const View = ruleLinkView(hold);
  const went: string[] = [];
  view = await mount(<harness.Harness>{wrap(<View navigate={to => void went.push(to)} />)}</harness.Harness>);
  await interact(() => {});
  return { harness, hold, went, view };
}

describe('the #rules link', () => {
  it('is declared as Accounts’ keyed fragment, with one device view', () => {
    expect(half.shell.fragments).toEqual([{ form: 'keyed', key: RULE_FRAGMENT_KEY }]);
    expect(Object.keys(half.shell.device ?? {})).toEqual(['rule-link']);
  });

  it('reads what the builder writes, and nothing else', () => {
    const hash = (link: string): string => link.slice(link.indexOf('#'));
    expect(ruleDeepLinkFromFragment(hash(ruleDeepLink(ORIGIN, STAGE_ID, B)))).toEqual({ stage: STAGE_ID, machine: B });
    expect(ruleDeepLinkFromFragment(hash(ruleDeepLink(`${ORIGIN}//`, STAGE_ID)))).toEqual({ stage: STAGE_ID });
    for (const bad of ['#rules/not-a-stage', `#rules/${STAGE_ID}?machine=elsewhere`, '#rules/%E0%A4%A', '#agenda/A1'])
      expect(ruleDeepLinkFromFragment(bad)).toBeNull();
  });

  it('opens on the machine it names: the address loses the link and that machine’s tab holds the stage', async () => {
    const { harness, hold, went } = await open(ruleDeepLink(ORIGIN, STAGE_ID, B), [row(A), row(B)]);
    expect(harness.address()).toBe('/');
    expect(went).toEqual([secureCopy(B)]);
    expect(hold.stageFor(B)).toBe(STAGE_ID);
    expect(hold.stageFor(A)).toBeUndefined();
  });

  it('naming no machine, opens on the machine on screen, else the first', async () => {
    window.history.replaceState(null, '', `/d/${B}`);
    const onB = await open(ruleDeepLink(ORIGIN, STAGE_ID), [row(A), row(B)], node => (
      <RouterProvider>{node}</RouterProvider>
    ));
    expect(onB.went).toEqual([secureCopy(B)]);
    await view?.unmount();
    window.history.replaceState(null, '', '/');
    const first = await open(ruleDeepLink(ORIGIN, STAGE_ID), [row(A), row(B)]);
    expect(first.went).toEqual([secureCopy(A)]);
  });

  it('naming a machine this device is not paired with, says so in one line and goes nowhere', async () => {
    const { harness, hold, went, view: mounted } = await open(ruleDeepLink(ORIGIN, STAGE_ID, C), [row(A), row(B)]);
    expect(went).toEqual([]);
    // The machines moving afterwards neither re-read the link nor take the notice away.
    harness.setRows([row(B), row(A)]);
    await interact(() => {});
    expect(went).toEqual([]);
    expect(hold.stageFor(A) ?? hold.stageFor(B) ?? hold.stageFor(C)).toBeUndefined();
    const notice = mounted.container.querySelector('[data-rule-linked-elsewhere]');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain(RULE_LINKED_ELSEWHERE_WORDS);
    await click(notice?.querySelector('button') as HTMLButtonElement);
    expect(mounted.container.querySelector('[data-rule-linked-elsewhere]')).toBeNull();
  });

  it('with no paired machine, or a link that is not one, is dropped without a word', async () => {
    const none = await open(ruleDeepLink(ORIGIN, STAGE_ID), []);
    expect(none.went).toEqual([]);
    expect(none.harness.address()).toBe('/');
    expect(none.view.container.textContent).toBe('');
    await view?.unmount();
    const bad = await open(`${ORIGIN}/#rules/not-a-stage`, [row(A)]);
    expect(bad.went).toEqual([]);
    expect(bad.harness.address()).toBe('/');
  });

  it('a second link on the open page is read again; the notice of the first goes', async () => {
    const { harness, hold, went, view: mounted } = await open(ruleDeepLink(ORIGIN, STAGE_ID, C), [row(A), row(B)]);
    expect(mounted.container.querySelector('[data-rule-linked-elsewhere]')).not.toBeNull();
    await interact(() => harness.arrive(ruleDeepLink(ORIGIN, OTHER_STAGE, A)));
    expect(went).toEqual([secureCopy(A)]);
    expect(hold.stageFor(A)).toBe(OTHER_STAGE);
    expect(mounted.container.querySelector('[data-rule-linked-elsewhere]')).toBeNull();
    // Rows moving later do not read the same arrival twice.
    harness.setRows([row(B), row(A)]);
    await interact(() => {});
    expect(went).toEqual([secureCopy(A)]);
  });
});

describe('the list a link opens on', () => {
  const drawn = async (daemon: string, hold: RuleLinkHold, list = ruleList({ stages: [machineStage()] })) => {
    const fake = ruleClient({ list });
    noteClientDaemon(fake.client as never, daemon);
    view = await mount(<SignInRulesSurface client={fake.client} pollMs={60_000} ruleLink={hold} />);
    await settle();
    return view;
  };

  it('highlights the linked row once its list is read, and spends the link', async () => {
    const hold = new RuleLinkHold();
    hold.hold(STAGE_ID, B);
    const mounted = await drawn(B, hold);
    const stage = mounted.container.querySelector(`[data-rule-stage="${STAGE_ID}"]`);
    expect(stage?.hasAttribute('data-highlighted')).toBe(true);
    expect(stage?.className).toContain('ring-accent');
    expect(hold.stageFor(B)).toBeUndefined();
    expect(mounted.container.querySelector('[data-rule-linked-gone]')).toBeNull();
  });

  it('says the approval is gone when the daemon no longer lists the stage', async () => {
    const hold = new RuleLinkHold();
    hold.hold(OTHER_STAGE, B);
    const mounted = await drawn(B, hold);
    expect(mounted.container.querySelector('[data-rule-linked-gone]')?.textContent).toBe(RULE_LINKED_STAGE_GONE_WORDS);
    expect(mounted.container.querySelector('[data-highlighted]')).toBeNull();
  });

  it('another machine’s list leaves the link alone, and a list with no link highlights nothing', async () => {
    const hold = new RuleLinkHold();
    hold.hold(STAGE_ID, B);
    const mounted = await drawn(A, hold);
    expect(mounted.container.querySelector('[data-highlighted]')).toBeNull();
    expect(hold.stageFor(B)).toBe(STAGE_ID);
    hold.settle(A);
    expect(hold.stageFor(B)).toBe(STAGE_ID);
  });

  it('a device that may not read the rules spends the link without a word', async () => {
    const hold = new RuleLinkHold();
    hold.hold(STAGE_ID, B);
    const fake = ruleClient({
      fail: key => (key === 'GET /v1/sign-in-rules' ? Object.assign(new Error('no'), { status: 403 }) : undefined),
    });
    noteClientDaemon(fake.client as never, B);
    view = await mount(<SignInRulesSurface client={fake.client} pollMs={60_000} ruleLink={hold} />);
    await settle();
    expect(hold.stageFor(B)).toBeUndefined();
    expect(view.container.querySelector('[data-rule-linked-gone]')).toBeNull();
  });
});
