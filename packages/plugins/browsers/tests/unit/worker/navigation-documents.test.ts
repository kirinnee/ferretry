import { describe, expect, test } from 'bun:test';
import type { Frame, Page } from 'playwright-core';
import { NavigationLedger } from '../../../daemon/target/lib/navigation-evidence.ts';
import { watchNavigationDocuments } from '../../../daemon/worker/navigation-documents.ts';

function fixture() {
  const listeners = new Map<string, (frame: Frame) => void>();
  let document: unknown = 'loader-1';
  let url = 'https://unknown.example.test/pair#v1;code=FAKE-PAIR-0000';
  const frame = {
    _connection: { toImpl: () => ({ _currentDocument: { documentId: document } }) },
    url: () => url,
  } as unknown as Frame;
  const page = {
    on: (event: string, listener: (frame: Frame) => void) => listeners.set(event, listener),
    mainFrame: () => frame,
  };
  const ledger = new NavigationLedger(() => 1);
  watchNavigationDocuments(page as unknown as Page, ledger);
  return {
    ledger,
    navigate: (address: string, loader: unknown) => {
      url = address;
      document = loader;
      listeners.get('framenavigated')?.(frame);
    },
  };
}

describe('D-07 browser-owned document identity', () => {
  test('same-document URL changes retain a link; only a proved new loader clears it', () => {
    const f = fixture();
    f.navigate('https://unknown.example.test/pair#v1;code=FAKE-PAIR-0000', 'loader-1');
    f.navigate('https://unknown.example.test/pair', 'loader-1');
    expect(f.ledger.evidence().linked).toBe(true);
    f.navigate('https://unknown.example.test/plain', 'loader-2');
    expect(f.ledger.evidence().linked).toBe(false);
  });

  test('a missing or unreadable native loader never proves the linked document has gone', () => {
    const f = fixture();
    f.navigate('https://unknown.example.test/pair#v1;code=FAKE-PAIR-0000', 'loader-1');
    for (const unknown of [undefined, null, '', 1, {}]) {
      f.navigate('https://unknown.example.test/pair', unknown);
      expect(f.ledger.evidence().linked).toBe(true);
    }
  });
});
