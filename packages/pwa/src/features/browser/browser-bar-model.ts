/**
 * THE ONE STATE CHIP OF THE BROWSER BAR — the decision, with no rendering.
 *
 * The browser tab used to spend five stacked rows on meta-information. They collapse into one bar, and
 * everything that was a row of its own becomes a fact this function ranks: the bar shows ONE chip, the
 * most important true thing about the page, and the rest of the facts live in the chip's detail and the
 * ⋯ menu.
 *
 * THE ORDER IS A SAFETY ORDER. A page the owner has taken over, a hand-over request and a human check
 * are the states a person must not miss, so they outrank a failure, a lost display and plain activity.
 * A lower-ranked fact never hides a higher one; it waits in the menu.
 */

import type { BrowserChallenge, BrowserStatus } from '@ferretry/protocol';

import { remoteBrowserPage, type RemoteBrowserConnection } from './remote-browser-chrome.tsx';
import type { BrowserEngine } from './unified-browser-model.ts';

type BrowserChipKind =
  | 'owner'
  | 'ask'
  | 'challenge'
  | 'error'
  | 'disconnected'
  | 'stopped'
  | 'starting'
  | 'agent'
  | 'working'
  | 'connecting'
  | 'live'
  | 'preview';

type BrowserChipTone = 'ok' | 'warn' | 'err' | 'accent' | 'pend';

export interface BrowserChip {
  readonly kind: BrowserChipKind;
  readonly tone: BrowserChipTone;
  /** Short enough for a phone: the chip never wraps and never scrolls. */
  readonly label: string;
  /** What the chip says in full — its tooltip and the heading of its detail. */
  readonly summary: string;
  /** A notice the person must see: it keeps its colour and the detail opens by itself on request, never silently. */
  readonly attention: boolean;
}

/** Who is driving the page, as the daemon reports it (`use-surface-driving`). */
export interface BrowserBarControl {
  readonly driver: { readonly name: string } | null;
  readonly ask: { readonly agent: string; readonly message?: string } | null;
  readonly takenOver: boolean;
}

export interface BrowserChipInput {
  readonly engine: BrowserEngine;
  readonly status: BrowserStatus | null;
  readonly connection: RemoteBrowserConnection;
  readonly busy: boolean;
  /** Every message the bar holds: a refused address, a failed action. Blank when there is none. */
  readonly errors: readonly string[];
  readonly challenge: BrowserChallenge | null;
  readonly control: BrowserBarControl;
}

const chip = (
  kind: BrowserChipKind,
  tone: BrowserChipTone,
  label: string,
  summary: string,
  attention = false,
): BrowserChip => ({ kind, tone, label, summary, attention });

export const browserChip = ({
  engine,
  status,
  connection,
  busy,
  errors,
  challenge,
  control,
}: BrowserChipInput): BrowserChip => {
  if (engine === 'preview')
    return chip(
      'preview',
      'pend',
      'Preview',
      'Preview reader — some sites refuse to load in it. Real is the full browser.',
    );
  if (control.takenOver) return chip('owner', 'accent', 'You', 'You have control of this page.', true);
  if (control.ask !== null)
    return chip('ask', 'warn', 'Your turn', control.ask.message ?? `${control.ask.agent} needs you here.`, true);
  if (challenge !== null)
    return chip('challenge', 'warn', 'Check', 'This page appears to be asking you to prove you’re a person.', true);
  const page = remoteBrowserPage(status);
  if (errors.length > 0 || page?.pageState === 'error' || status?.state === 'error')
    return chip('error', 'err', 'Error', errors[0] ?? page?.pageError ?? 'The browser reported a problem.', true);
  if (status?.state === 'stopped') return chip('stopped', 'pend', 'Stopped', 'The browser is stopped.');
  if (status?.state === 'starting' || status?.state === 'stopping')
    return chip(
      'starting',
      'pend',
      status.state === 'starting' ? 'Starting' : 'Stopping',
      `The browser is ${status.state}.`,
    );
  if (connection === 'disconnected')
    return chip('disconnected', 'err', 'Offline', 'The display disconnected — reconnecting…', true);
  if (control.driver !== null)
    return chip('agent', 'accent', `${control.driver.name} typing`, `${control.driver.name} is typing here.`);
  if (busy || page?.pageState === 'loading')
    return chip('working', 'pend', 'Working', busy ? 'Working…' : 'Loading page…');
  if (connection !== 'connected' || status === null)
    return chip('connecting', 'pend', 'Connecting', 'Connecting to the browser…');
  return chip('live', 'ok', 'Live', 'Live display.');
};
