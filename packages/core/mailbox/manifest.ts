import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import { DeliveryWays, MailboxHosts } from './contract/index.ts';

/**
 * Mailbox (§2.3): the one way a message reaches a ferret. Core, because every message goes through it. It decides WHEN
 * and HOW a message is delivered (the queue, its lanes and gates, the send ledger and its proof); Conversation keeps the
 * chat. This first step (c58-m0a) only lays the package down: the contract the logic will live behind and the one slot
 * (`mailbox.host`) Conversation fills with the stores over the files it keeps. No route, tool or screen moves yet.
 */
export default definePlugin({
  id: 'mailbox',
  title: 'Mailbox',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  words: [
    { word: 'mailbox', means: 'where a message to a ferret waits until it can be delivered', insteadOf: ['outbox'] },
  ],
  needs: { ferrets: FerretsPort },
  // The Mailbox offers the delivery-way slot and contributes the first way itself (the ferret's terminal, through Ferrets).
  hooks: { offers: [{ hook: MailboxHosts }, { hook: DeliveryWays }], takes: [{ hook: DeliveryWays }] },
  doctor: ['mailbox-host', 'mailbox-ways'],
});
