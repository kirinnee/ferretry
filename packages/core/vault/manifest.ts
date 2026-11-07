import { AskSources, AsksPort } from '@ferretry/core-asks/contract';
import { GatePort } from '@ferretry/core-gate/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import {
  ChildEnvironmentPort,
  HoldsChanged,
  HoldsFile,
  InputAskRefSchema,
  InputHoldsPort,
  InputRequestFiles,
  InputTargets,
  OutputGuardPort,
  RedactionPort,
  SecretsChanged,
  VaultFile,
  VaultKeyFile,
  VaultPort,
} from './contract/index.ts';

/**
 * Vault (§2.2): keeps secrets ferrets use but never see; types values the owner gives into a terminal or page; hides
 * them everywhere afterwards. Core. Its routes (secrets, input requests, holds) are added by the Vault port with
 * today's descriptors; the day-1 spine declares the contract surface only.
 */
export default definePlugin({
  id: 'vault',
  title: 'Vault',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  words: [
    { word: 'secret', means: 'a value ferrets use by name and never see', insteadOf: ['credential', 'env var'] },
    { word: 'input', means: 'a card asking you to type a value', insteadOf: ['input request'] },
    {
      word: 'hold',
      means: 'a short time a terminal or page is closed to ferrets after you typed into it',
      insteadOf: ['quarantine', 'lock'],
    },
    { word: 'mask', means: 'hiding a secret in text', insteadOf: ['redact', 'scrub'] },
  ],
  needs: { gate: GatePort, asks: AsksPort },
  provides: {
    vault: VaultPort,
    outputGuard: OutputGuardPort,
    inputHolds: InputHoldsPort,
    redaction: RedactionPort,
    childEnvironments: ChildEnvironmentPort,
  },
  data: {
    state: [VaultFile, VaultKeyFile, HoldsFile, InputRequestFiles],
    publishes: [SecretsChanged, HoldsChanged],
  },
  hooks: {
    offers: [{ hook: InputTargets }],
    takes: [{ hook: AskSources, key: 'input', schema: InputAskRefSchema }],
  },
});
