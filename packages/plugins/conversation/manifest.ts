import { definePlugin } from '@ferretry/kernel/manifest';
import { CONVERSATION_CONFIG, CONVERSATION_STATE, ConversationPort, MailboxPort } from './contract/index.ts';
import { AsksPort } from '@ferretry/core-asks/contract';
import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { AccessPort } from '@ferretry/plugin-access/contract';
import { ClaudeCodePort } from '@ferretry/plugin-claude-code/contract';
import actions, { data, hooks, ui } from './manifest/generated/actions.ts';

/**
 * Conversation (§2.3): what you say to a ferret and what it says back. Descriptors are today's mounts
 * (session-send, session-reads, session-answer, session-attachments, session-compact-at, session-hypermedia, renders,
 * shared-drafts, conversation-import, foreign-history, work-search), with `/v1/sessions/:sessionId/…` now
 * `/v1/ferrets/:ferretId/…` and `/v1/imports/…` now `/v1/links/…`. Gate's per-route `capability` is copied unchanged.
 *
 * This file is the hand-written shell: who the plugin is and what it needs. Its routes, verbs, tools, app actions, screens,
 * panels, hooks and events are `manifest/actions/NN-<feature>.actions.ts`, merged by the generator in file-name order.
 */
export default definePlugin({
  id: 'conversation',
  title: 'Conversation',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
  words: [
    { word: 'message', means: 'one thing said to or by a ferret', insteadOf: ['prompt'] },
    { word: 'turn', means: 'one round of a ferret working' },
    { word: 'question', means: 'a ferret asking you mid-turn' },
    {
      word: 'link',
      means: "a conversation read from the harness's own file, not copied",
      insteadOf: ['import'],
    },
  ],

  needs: { ferrets: FerretsPort, asks: AsksPort, mailbox: MailboxPort },
  // Optional: the chat reads the observer's stored turn state and its instant, and what the pane is stopped on, from Claude
  // Code's redacted prompt route (`GET /v1/ferrets/:ferretId/prompt`). Without it the chat claims no dated turn.
  // Access: the composer's location chip reads the per-device "turn location back on" steps from Access's
  // `access.how-to-enable-location` hook; without it the chip keeps its generic steps.
  uses: { claudeCode: ClaudeCodePort, access: AccessPort },
  provides: { conversation: ConversationPort },

  actions: { ...actions },

  ui: { ...ui },

  /** Never reached by a ferret, through any root: the key that signs a message token (`PrivacyDecl`). */
  privacy: {
    private: ['message-token.key'],
  },
  data: {
    state: CONVERSATION_STATE,
    config: [CONVERSATION_CONFIG],
    readModels: ['transcript', 'queue', 'sends', 'logs', 'search', 'links'],
    ...data,
  },

  hooks: { ...hooks },

  // Conversation reads the owner's history through `harness-history` (links); copy-on-link is the harness plugin's own act
  // (`FerretsApi.importConversation`). Transcripts are read only through the harness's `TranscriptReader`.
  doctor: ['conversation-store', 'conversation-search-index'],
  workers: ['pdf-decrypt'],
  permissions: { roots: ['harness-history'] },
});
