/**
 * The hooks Conversation takes and offers.
 *
 * One fragment, not one per feature: the takes of one feature are not contiguous in the built manifest (attachments take
 * `FerretStopping` before hypermedia's `LaunchParts` and `OpeningAttachments` after it, and the question source and
 * `QuestionOpen` bracket the list), so splitting them would move an entry. A new feature's hook is a line here until the
 * order is no longer pinned.
 */
import {
  AskDeliveries,
  AskOwnerChats,
  ASK_DELIVERY_KEY,
  ASK_OWNER_CHAT_KEY,
  AskSources,
} from '@ferretry/core-asks/contract';
import {
  FerretChanged,
  FerretStopping,
  LaunchParts,
  OPENING_ATTACHMENTS_KEY,
  OpeningAttachments,
  QUESTION_OPEN_KEY,
  QuestionOpen,
  SitrepLines,
} from '@ferretry/core-ferrets/contract';
import {
  MAILBOX_HOST_KEY,
  MailboxHosts,
  MessageBeforeSend,
  PromptAskRefSchema,
  QuestionSchema,
  ReferenceCatalog,
  SearchSources,
  TurnEnded,
} from '../../contract/index.ts';
import { fragment } from '../kit.ts';

export default fragment({
  hooks: {
    takes: [
      { hook: AskSources, key: 'question', schema: QuestionSchema },
      { hook: AskSources, key: 'prompt', schema: PromptAskRefSchema },
      { hook: SitrepLines, priority: 50 },
      // A ferret that stops has its unlocked attachments zeroed; every change of state is a look for `turn.ended`.
      { hook: FerretChanged },
      // A stop is being attempted: the unlocked attachments are zeroed whether or not it then succeeds.
      { hook: FerretStopping },
      // What a launch says about hypermedia: only a switch the owner set (a ferret with none keeps its mode default).
      { hook: LaunchParts },
      // The files a start was given (`fy start -f`): this plugin owns attachments, so it is THE one provider that plans
      // them (a security-path provide hook naming only `conversation` as its taker).
      { hook: OpeningAttachments, key: OPENING_ATTACHMENTS_KEY },
      // How an owner's agenda answer reaches a ferret: typed through this plugin's own send path (queue + ledger). The
      // one provider of this security-path hook (`takers: ['conversation']`).
      { hook: AskDeliveries, key: ASK_DELIVERY_KEY },
      // The owner's chat as `fy agenda log` copies it onto an item: this plugin's own queue and send ledger. The one
      // provider of this hook (`takers: ['conversation']`).
      { hook: AskOwnerChats, key: ASK_OWNER_CHAT_KEY },
      // The composer's `:` (the ferrets, by callsign) and `@` (one folder of the ferret's files) menus: the facts are
      // Ferrets', read through its port, and the composer's reference catalog is this plugin's own (a core piece may not
      // take a plugin's hook, so Ferrets cannot provide them).
      { hook: ReferenceCatalog, key: ':' },
      { hook: ReferenceCatalog, key: '@' },
      // The queue log and send ledger the Mailbox runs over: the files stay in this plugin's folder (the one provider of this
      // security-path hook, `takers: ['conversation']`).
      { hook: MailboxHosts, key: MAILBOX_HOST_KEY },
      // Whether a ferret has a question open: the stored `question.json` is this plugin's, and Ferrets' turn watch reads a
      // yes as "waiting on a person" (the one provider: `takers: ['conversation']`).
      { hook: QuestionOpen, key: QUESTION_OPEN_KEY },
    ],
    offers: [{ hook: MessageBeforeSend }, { hook: TurnEnded }, { hook: SearchSources }, { hook: ReferenceCatalog }],
  },
});
