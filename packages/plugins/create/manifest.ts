import { AskSources, AsksPort, type SourceKey } from '@ferretry/core-asks/contract';
import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { cap } from '@ferretry/core-gate/contract';
import { definePlugin, tool } from '@ferretry/kernel/manifest';
import {
  CREATE_AUDIT,
  CREATE_SPEND_SOURCE,
  CREATE_WORDS,
  CreateConfigDef,
  CreateSpendRefSchema,
  GenerateImageInputSchema,
  GenerateMusicInputSchema,
  GenerateSfxInputSchema,
  GenerateSpeechInputSchema,
  CREATE_GUARD,
  SPEND_LEDGER,
} from './contract/index.ts';

/**
 * Create (&F6407): creative tools for agents that cannot make media themselves: the price table, the spend ledger, the
 * daily cap and the ask over a limit, with `generate_image`, `generate_sfx` and `generate_music` through fal and
 * `generate_speech` through ElevenLabs. Video and a longer-lived media route are the units after it.
 *
 * THE KEYS. `FAL_KEY` and `ELEVENLABS_API_KEY` are Vault secrets named only by this plugin's own `create.yaml`
 * (`fal.key`, `elevenlabs.key`, added by the owner), and the kernel places each on the request
 * (`kernel.secrets.send`) to the API hosts named below, exactly. Create never holds one; no route, tool answer or
 * ledger line carries it. ElevenLabs audio comes as base64 in JSON (the Vault returns nothing else), and ElevenLabs
 * music goes through fal, so the Vault was not widened (O4).
 *
 * THE LIMITS (owner, !A616): $5 a day in all, refused past it; one call over $1 asks the owner on the agenda and
 * waits for the owner (the existing Asks path, source `create-spend`); a call whose price cannot be read is refused.
 */
export default definePlugin({
  id: 'create',
  title: 'Create',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  words: CREATE_WORDS,

  // Ferrets: the one seam that hands a ferret a file. Asks: the ask the owner answers.
  needs: { ferrets: FerretsPort, asks: AsksPort },
  provides: {},

  actions: {
    agentTools: [
      tool('generate_image', {
        minimum: 'authenticated',
        caller: 'any',
        capability: cap('fleet', 'use'),
        audit: CREATE_AUDIT,
        guard: CREATE_GUARD,
        input: GenerateImageInputSchema,
        summary:
          'Make one picture from a written description with fal (flux-schnell by default). It is priced before it is sent; over the owner’s one-call limit it asks them first.',
      }),
      tool('generate_speech', {
        minimum: 'authenticated',
        caller: 'any',
        capability: cap('fleet', 'use'),
        audit: CREATE_AUDIT,
        guard: CREATE_GUARD,
        input: GenerateSpeechInputSchema,
        summary:
          'Read a text aloud as one audio file with ElevenLabs (1 500 characters at most). It is priced before it is sent; over the owner’s one-call limit it asks them first.',
      }),
      tool('generate_sfx', {
        minimum: 'authenticated',
        caller: 'any',
        capability: cap('fleet', 'use'),
        audit: CREATE_AUDIT,
        guard: CREATE_GUARD,
        input: GenerateSfxInputSchema,
        summary:
          'Make one short sound effect (0.5–22 s) from a description with fal. It is priced before it is sent; over the owner’s one-call limit it asks them first.',
      }),
      tool('generate_music', {
        minimum: 'authenticated',
        caller: 'any',
        capability: cap('fleet', 'use'),
        audit: CREATE_AUDIT,
        guard: CREATE_GUARD,
        input: GenerateMusicInputSchema,
        summary:
          'Make a short piece of music (3–60 s) from a description with fal. fal bills it by the whole minute; it is priced before it is sent, and over the owner’s one-call limit it asks them first.',
      }),
    ],
  },

  data: {
    state: [SPEND_LEDGER],
    config: [CreateConfigDef],
  },

  // What was spent is the owner's to read, never a ferret's to edit.
  privacy: { private: ['ledger.jsonl'] },

  hooks: {
    takes: [{ hook: AskSources, key: CREATE_SPEND_SOURCE as SourceKey, schema: CreateSpendRefSchema }],
  },

  permissions: {
    // A key is only ever placed on the exact hosts; the CDN is a wildcard, which the kernel never lets a key reach.
    network: ['fal.run', 'api.fal.ai', 'api.elevenlabs.io', '*.fal.media'],
    secrets: ['FAL_KEY', 'ELEVENLABS_API_KEY'],
  },
});
