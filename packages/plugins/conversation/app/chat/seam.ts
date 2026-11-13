/**
 * THE CHAT'S SEAM: every name the chat and transcript files took from a PWA module that is NOT Conversation's and has
 * no `@ferretry/app` export, kept in ONE file so its owner can replace each in one place. Nothing here is new
 * behaviour: each is a short marked copy of today's shape, or a stand-in that behaves as today's code does when the
 * thing it stands for is absent.
 *
 *   - FerretActionContribution / FerretActionEntry .... GAP(ferrets, Q1): today's `session-actions/registry.ts` shapes
 *     (the `run` and `confirm` entries the chat contributes: "Clear stuck messages", "Dismiss all cancelled"). The
 *     Actions menu that lists them is the Ferrets app half's; until it lands the chat builds them and nothing lists them.
 *   - AgendaMessageOr / useAgendaChatReply ............ GAP(agenda): the agenda card an answer from the Agenda reads as
 *     (today's `agenda-message.tsx`). Its reader (`parseAgendaMessage`) is the Asks daemon's protocol and the Agenda
 *     app's copy; neither is a contract Conversation may import. Until Agenda draws it here (a `conversation.row`
 *     panel), every agenda message is drawn as it always was when it was not recognised: its words (`fallback`).
 */

import type { LucideIcon } from 'lucide-react';
import { createElement, Fragment, type ReactNode } from 'react';

// ─── the ferret's Actions menu (Ferrets) ───────────────────────────────────────────────────────────────────────────

type FerretActionGroup = 'session' | 'move' | 'tools' | 'learning' | 'warden' | 'danger';

interface EntryBase {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** A short count or state beside the label. */
  readonly detail?: string;
  readonly danger?: boolean;
  /** Why the entry cannot run now: it is listed, disabled, with this reason. */
  readonly unavailable?: string;
}

/** The two entry kinds the chat contributes (today's `SessionActionEntry` `run` and `confirm`). */
type FerretActionEntry =
  | (EntryBase & { readonly kind: 'run'; readonly run: () => Promise<void> | void })
  | (EntryBase & {
      readonly kind: 'confirm';
      readonly question: string;
      readonly consequence: string;
      readonly confirmLabel: string;
      readonly run: () => Promise<void> | void;
    });

export interface FerretActionContribution<Context> {
  readonly group: FerretActionGroup;
  /** Ascending within its group. */
  readonly order: number;
  readonly build: (context: Context) => FerretActionEntry | null;
}

// ─── the agenda card a message reads as (Agenda) ───────────────────────────────────────────────────────────────────

/** A message drawn as its agenda card, or as `fallback` when it is not one. GAP(agenda): always `fallback` here. */
export function AgendaMessageOr({ fallback }: { readonly text: string; readonly fallback: ReactNode }) {
  return createElement(Fragment, null, fallback);
}

/** A message on its way, worded as the ferret will receive it. GAP(agenda): the open items are not read here. */
export const useAgendaChatReply = (text: string): string => text;
