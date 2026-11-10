/**
 * R9 — onboarding asks no carrier question. The part of that sentence Connections owns is what it hands the first-run
 * daemon step to SAY (the hosted-relay note, the carrier disclosure) and that nothing has to be chosen for a connection
 * to work. The note component itself is rendered by Onboarding; this proves its connections-owned words are statements
 * and that a machine nobody chose for already has an answer.
 */
import { describe, test } from 'bun:test';
import should from 'should';
import {
  activeCarrierStatus,
  carrierDisclosure,
  HOSTED_RELAY_DISABLED_NOTE,
  HOSTED_RELAY_DISCLOSURE,
  HOSTED_RELAY_ROW_NOTE,
  HOSTED_RELAY_UNDETERMINED_NOTE,
  TRANSPORT_NOT_WIRED_NOTE,
} from '../../../app/discovery/hosted-relay.ts';
import {
  CARRIER_PREFERENCES,
  CarrierPreferenceStore,
  DEFAULT_CARRIER_PREFERENCE,
} from '../../../app/lib/carrier-preference.ts';

describe('onboarding carrier words', () => {
  test('R9 every connections-owned first-run note states what happens and asks nothing', () => {
    const disclosure = carrierDisclosure();
    const words = [
      activeCarrierStatus(),
      HOSTED_RELAY_ROW_NOTE,
      HOSTED_RELAY_DISABLED_NOTE,
      HOSTED_RELAY_UNDETERMINED_NOTE,
      TRANSPORT_NOT_WIRED_NOTE,
      disclosure.inUse,
      ...HOSTED_RELAY_DISCLOSURE,
      ...disclosure.fallbackWouldSee,
    ];
    should(words.length).be.above(6);
    for (const sentence of words) {
      should(sentence).not.match(/\?/u);
      should(sentence).not.match(/\b(choose|pick|select|which carrier|would you like)\b/iu);
    }
  });

  test('R9 a machine nobody chose a carrier for already has one, so first run has nothing to ask', () => {
    const store = new CarrierPreferenceStore();
    should(CARRIER_PREFERENCES).containEql(DEFAULT_CARRIER_PREFERENCE);
    should(store.preference('fy_daemon_never_chosen')).equal(DEFAULT_CARRIER_PREFERENCE);
  });
});
