import { audit, cap, GatePort } from '@ferretry/core-gate/contract';
import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import { definePlugin, panel, route, settingsTab, socket, verb } from '@ferretry/kernel/manifest';
import {
  CLEANUP_PROVIDERS,
  ELEVENLABS_HOST,
  ELEVENLABS_SECRET_NAME,
  ENGINE_HOSTS,
  MODELS_STATE,
  REPLY_SPEND_STATE,
  SPEEDUP_TESTS_STATE,
  VOICE_CONFIG,
  VOICE_READ_MODELS,
  VoicePort,
} from './contract/index.ts';
import {
  CONVERSATION_ABOVE_COMPOSER_SLOT,
  CONVERSATION_COMPOSER_SLOT,
  CONVERSATION_ROW_ACTIONS_SLOT,
  ConversationPort,
} from '@ferretry/plugin-conversation/contract';
import { LoginsPort } from '@ferretry/plugin-logins/contract';

/**
 * Voice (§2.3): talk instead of type. Recognition runs in the browser; the daemon's part is the one JSON exchange a
 * browser cannot perform (`POST /v1/stt/enhance`: a transcript repaired by a hosted chat model, spending a key only the
 * daemon holds, R626: no audio crosses the daemon; a person's act, since a ferret may not trigger a paid call unattended) and the speed-up keys' status and Test. Routes are today's mounts
 * (`stt.ts`, `speedups.ts`), descriptor fields copied exactly; the paths contain no replaced word, so they are kept.
 *
 * Keys are Vault secrets by NAME (`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `JEV_API_KEY`), spent only through the Vault's
 * outbound holder (`authorizeFetch`, S162–S166); `voice.yaml` never holds one.
 */
export default definePlugin({
  id: 'voice',
  title: 'Voice',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view', 'command'],
  words: [{ word: 'dictate', means: 'speak a message', insteadOf: ['STT'] }],

  // The machine speech engine's worker thread (voice mode): `fyd --check` starts it, so a binary without it is seen at once.
  workers: ['speech', 'reply'],
  // `fyd --check` loads the native speech engine (once Install has fetched it) from this binary: the `voice` line.
  selftest: ['voice'],

  // Gate to record the messages the stream sends; Ferrets to say which ferret a name means (as a typed send does).
  needs: { vault: VaultPort, gate: GatePort, ferrets: FerretsPort },
  // Conversation is optional: Read aloud is drawn in its transcript, and with Conversation off there is no transcript.
  uses: { logins: LoginsPort, conversation: ConversationPort },
  provides: { voice: VoicePort },

  actions: {
    routes: [
      route('POST /v1/stt/enhance', {
        minimum: 'operator',
        caller: 'person',
        audit: {
          skip: 'not recorded today (no rule in lib/audit/routes.ts); the payload is dictated speech and is never logged',
        },
        guard: { none: 'the dictated transcript and its repaired copy; no pane, page or vault text' },
      }),
      route('GET /v1/voice/engine', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('voice', 'use'),
        noStore: true,
        audit: { skip: 'a read of an install state, sizes and counters' },
        guard: { none: 'a state, byte counts and one fixed sentence; no audio and no transcript' },
      }),
      route('POST /v1/voice/engine/install', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('voice', 'configure'),
        noStore: true,
        // Public model files and one native library (the install puts native CODE in the daemon), all pinned and hash-checked; no secret is sent and none is returned.
        audit: {
          skip: 'downloads pinned files onto this machine, INCLUDING a compiled native library the daemon later loads into its own process (hash-checked before every load); no audit kind records it yet (declared gap, docs/design/voice-modes.md §2.3.1); carries no secret and no audio',
        },
        guard: { none: 'a state, byte counts and one fixed sentence; no audio and no transcript' },
      }),
      route('DELETE /v1/voice/engine', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('voice', 'configure'),
        noStore: true,
        audit: { skip: 'deletes the downloaded speech files from this machine; carries no secret and no audio' },
        guard: { none: 'a state, byte counts and one fixed sentence; no audio and no transcript' },
      }),
      // The reply voice (Kokoro): installed apart from the speech engine; the same three acts and the same two capabilities.
      route('GET /v1/voice/reply-voice', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('voice', 'use'),
        noStore: true,
        audit: { skip: 'a read of an install state, sizes and a measurement' },
        guard: { none: 'a state, byte counts and one fixed sentence; no audio and no text that was spoken' },
      }),
      route('POST /v1/voice/reply-voice/install', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('voice', 'configure'),
        noStore: true,
        audit: {
          skip: 'downloads pinned files onto this machine, INCLUDING a compiled native library the daemon later loads into its own process (hash-checked before every load); no audit kind records it yet (declared gap, docs/design/voice-modes.md §2.3.1); carries no secret and no audio',
        },
        guard: { none: 'a state, byte counts and one fixed sentence; no audio and no text that was spoken' },
      }),
      route('DELETE /v1/voice/reply-voice', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('voice', 'configure'),
        noStore: true,
        audit: { skip: 'deletes the downloaded voice files from this machine; carries no secret and no audio' },
        guard: { none: 'a state, byte counts and one fixed sentence; no audio and no text that was spoken' },
      }),
      // ElevenLabs as the reply voice: which voice, which model and what is spent today. A read of names and counts; the key is not opened.
      route('GET /v1/voice/reply-voice/elevenlabs', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('voice', 'use'),
        noStore: true,
        audit: { skip: 'a read of a chosen voice id, a count of characters and whether a key name exists' },
        guard: { none: 'ids, counts and booleans; no key, no audio and no text that was spoken' },
      }),
      // The picker's list spends the key once, on the owner's account, to read the voices it can speak with: a person's act.
      route('GET /v1/voice/reply-voice/elevenlabs/voices', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('secrets', 'use'),
        noStore: true,
        audit: audit('secrets.used'),
        guard: {
          none: 'voice ids and names the account holds; never the provider body, a key or a text that was spoken',
        },
      }),
      route('GET /v1/speedups', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('secrets', 'use'),
        noStore: true,
        audit: { skip: 'a read of secret names and instants; it never opens the vault' },
        guard: { none: 'names, booleans, instants and fixed sentences; no key and no provider body' },
      }),
      route('POST /v1/speedups/:provider/test', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('secrets', 'use'),
        noStore: true,
        // A Test spends one provider key on the operator's account; the secret's NAME is the subject.
        audit: audit('secrets.used'),
        guard: { none: 'a code and one fixed sentence; never the provider body' },
      }),
    ],
    sockets: [
      // The voice stream (§14, unit 4): the microphone up, the words down, and the machine sends each finished turn to the
      // ferret itself, which needs fleet.use as well as voice.use (checked at the start and before every send). A person's own device only: a ferret's session credential is not a grant caller, so `caller: 'person'`
      // is what keeps it from streaming audio to this machine or sending as the person.
      socket('GET /v1/voice/stream', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('voice', 'use'),
        audit: {
          skip: 'a stream is opened, not an act: each message it sends is recorded by the stream itself, as a typed send is (agent.prompted, action send)',
        },
        guard: {
          none: "audio in and fixed-shape snapshots out; the words are the speaker's own, from no pane, page or vault",
        },
      }),
    ],
    cli: [
      verb('voice [text...]', {
        summary: 'clean up dictated text through the enhancement provider (same as voice enhance)',
        args: [{ name: 'text', help: 'the text to clean up', variadic: true }],
        options: [
          { flag: '-m, --model <model>', help: 'the enhancement model to use instead of the provider default' },
          { flag: '-t, --term <term>', help: 'a proper noun the model keeps mangling; repeat for each (default: [])' },
          { flag: '-c, --context <text>', help: 'what the dictation is about, to disambiguate homophones' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('voice enhance', {
        summary: 'clean up dictated text — punctuation, casing and proper nouns',
        args: [{ name: 'text', help: 'the text to clean up', variadic: true }],
        options: [
          { flag: '-m, --model <model>', help: 'the enhancement model to use instead of the provider default' },
          { flag: '-t, --term <term>', help: 'a proper noun the model keeps mangling; repeat for each (default: [])' },
          { flag: '-c, --context <text>', help: 'what the dictation is about, to disambiguate homophones' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
    ],
  },

  ui: {
    panels: [
      panel('composer.tools', { id: 'dictation', order: 20 }),
      // "Read aloud" in an assistant message's footer (Conversation's `conversation.row-actions` slot).
      panel(CONVERSATION_ROW_ACTIONS_SLOT, { id: 'read-aloud', order: 10 }),
      // "Read replies aloud": reads a finished reply (or a question) while the device setting is on (Conversation's `conversation.above-composer` slot).
      panel(CONVERSATION_ABOVE_COMPOSER_SLOT, { id: 'auto-read', order: 40 }),
      // Voice mode: its button in the composer's tools, and its panel standing in front of the composer (Conversation's `conversation.composer` slot).
      panel('composer.tools', { id: 'voice-mode-button', order: 25 }),
      panel(CONVERSATION_COMPOSER_SLOT, { id: 'voice-mode', order: 10 }),
      // First-run steps (Onboarding's steps screen offers this slot): this device's two client steps, Voice then Speed-ups.
      panel('onboarding.step', { id: 'onboarding-voice', order: 3 }),
      panel('onboarding.step', { id: 'onboarding-speedups', order: 4 }),
      // One provider's key row (subject = the provider): a page that is not Settings (the Warden's first run) mounts the Jev one.
      panel('settings', { id: 'speedup-key', order: 80 }),
    ],
    settings: [
      // Split by where it is kept (r10 S5): Voice holds what THIS BROWSER does (dictation, engine, shortcut, auto-read, device keys);
      // Voice clean-up is the machine's own `voice.yaml` prompts, shared by every device paired to it.
      settingsTab('voice', { icon: 'mic', group: 'behaviour', label: 'Voice', order: 60, scope: 'device' }),
      settingsTab('voice-cleanup', {
        icon: 'sparkles',
        group: 'behaviour',
        label: 'Voice clean-up',
        order: 61,
        scope: 'machine',
      }),
      settingsTab('speedups', { icon: 'zap', group: 'advanced', label: 'Speed-ups', order: 70 }),
    ],
  },

  data: {
    state: [SPEEDUP_TESTS_STATE, MODELS_STATE, REPLY_SPEND_STATE],
    config: [VOICE_CONFIG],
    readModels: [...VOICE_READ_MODELS],
  },

  // First run, this DEVICE's half (r10 O15): Voice (the engine cards), then Speed-ups (the keys this browser holds), which
  // draws only after a local engine was picked. Both configure the browser, so each is asked once per device.
  onboarding: [
    { id: 'voice', title: 'Voice', order: 3, side: 'client', stepHost: true },
    { id: 'speedups', title: 'Speed-ups', order: 4, side: 'client', stepHost: true },
  ],

  // What a ferret is told about voice mode (`instructions/voice.md`): Voice's own words, so with Voice off a ferret is told
  // nothing of `<voice>` lines. A lead is who the person talks to (a helper reports to its lead), and no harness is named so
  // Claude and Codex both read it. The grammar it teaches is Conversation's `<voice>` tag (`contract/voice-tag.ts`).
  instructions: [{ id: 'voice', text: 'instructions/voice.md', when: { role: 'lead' } }],

  permissions: {
    // Keys ride only on requests the Vault's outbound holder builds; the hosts are the provider table's.
    network: [
      CLEANUP_PROVIDERS.groq.host,
      CLEANUP_PROVIDERS.cerebras.host,
      'api.typesafe.ai',
      ELEVENLABS_HOST,
      ...ENGINE_HOSTS,
    ],
    secrets: ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'JEV_API_KEY', ELEVENLABS_SECRET_NAME],
    // Only `diskFreeBytes`: Install asks how much room the models folder has before it downloads 700 MB.
    hostFacts: true,
  },
});
