/**
 * R627 / R628: the 4440 close and the data byte budget are tunnel vocabulary exported ONCE, by the kernel session
 * layer. The app imports them; it never redefines them (a second copy is an invisible disagreement between ends).
 */

import { describe, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import * as kernelSession from '@ferretry/kernel/session';
import * as appWire from '../../../src/session/wire/index.ts';

const appSource = new URL('../../../src/', import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

async function declarationsOf(name: string): Promise<readonly string[]> {
  const declaration = new RegExp(`\\b(?:const|let|var|function|class|type|interface)\\s+${name}\\b`);
  const found: string[] = [];
  for (const path of await sourceFiles(appSource))
    if (declaration.test(await Bun.file(path).text())) found.push(path.slice(appSource.length));
  return found;
}

async function sessionClientSource(): Promise<string> {
  return Bun.file(new URL('../../../src/session/session-client.ts', import.meta.url).pathname).text();
}

describe('app tunnel imports from the kernel session layer', () => {
  it('R627 the 4440 close code and reason are the kernel session layer export, not a local copy', async () => {
    should(kernelSession.RELAY_SESSION_CONCLUDED_CLOSE_CODE).equal(4440);
    should(kernelSession.RELAY_SESSION_CONCLUDED_CLOSE_REASON).equal('the session concluded');
    // The app's wire entry no longer carries either name, so nothing can resolve to an app-owned copy.
    should(Object.keys(appWire)).not.containEql('RELAY_SESSION_CONCLUDED_CLOSE_CODE');
    should(Object.keys(appWire)).not.containEql('RELAY_SESSION_CONCLUDED_CLOSE_REASON');
    should(await declarationsOf('RELAY_SESSION_CONCLUDED_CLOSE_CODE')).eql([]);
    should(await declarationsOf('RELAY_SESSION_CONCLUDED_CLOSE_REASON')).eql([]);
    const source = await sessionClientSource();
    should(source).match(/import \{[^}]*RELAY_SESSION_CONCLUDED_CLOSE_CODE[^}]*\} from '@ferretry\/kernel\/session'/);
  });

  it('R628 the data byte budget the app derives is the kernel relayDataByteBudget', async () => {
    should(typeof kernelSession.relayDataByteBudget).equal('function');
    should(Object.keys(appWire)).not.containEql('relayDataByteBudget');
    should(await declarationsOf('relayDataByteBudget')).eql([]);
    const source = await sessionClientSource();
    should(source).match(/import \{[^}]*\brelayDataByteBudget\b[^}]*\} from '@ferretry\/kernel\/session'/);
    should(source).match(/relayDataByteBudget\(MAX_PLAINTEXT_BYTES\)/);
    // The kernel's arithmetic: floor(3/4 × (ceiling − the one-record envelope)), total on a tiny ceiling.
    should(kernelSession.relayDataByteBudget(0)).equal(0);
    should(kernelSession.relayDataByteBudget(1_000)).equal(
      Math.floor(((1_000 - JSON.stringify({ t: 'data', bytes: '' }).length) * 3) / 4),
    );
  });
});
