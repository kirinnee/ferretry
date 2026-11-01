import { describe, it } from 'bun:test';
import type { SignInRulesDocument } from '@ferretry/protocol';
import should from 'should';
import { FileSignInRuleStore } from '../../../src/adapters/sign-in-rules/index.ts';
import { SignInRuleService } from '../../../src/lib/sign-in-rules/index.ts';
import { approved, FakeProofs, HOST_OWNER, NOW, world } from './support.ts';

/**
 * THE RULES FILE IS STRICT AND FAILS CLOSED (r3c-plan §5, invariant 8): anything that does not parse is zero rules,
 * audited, and the owner's next write moves the damaged file aside, never deleting it.
 */

const DIRECTORY = '/state/accounts';
const FILE = `${DIRECTORY}/sign-in-rules.json`;

/** The three calls the store makes, over a map of paths. */
class MemoryFiles {
  readonly files = new Map<string, string>();
  readonly directories: [string, number][] = [];
  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }
  async ensureDirectory(path: string, mode: number): Promise<void> {
    this.directories.push([path, mode]);
  }
}

/** A real document with one approved rule, as the service writes it. */
async function oneRule(): Promise<SignInRulesDocument> {
  const w = await world();
  await approved(w);
  if (w.store.document === undefined) throw new Error('nothing written');
  return w.store.document;
}

const damages = async (): Promise<readonly [string, string][]> => {
  const good = await oneRule();
  const [rule] = good.rules;
  if (rule === undefined) throw new Error('no rule');
  const other = { ...rule, body: { ...rule.body, id: `sr_${'e'.repeat(24)}` } };
  return [
    ['a later version', JSON.stringify({ ...good, v: 2 })],
    ['an extra key', JSON.stringify({ ...good, extra: true })],
    ['an extra key in a record', JSON.stringify({ ...good, rules: [{ ...rule, widened: true }] })],
    ['a bad rule id', JSON.stringify({ ...good, rules: [{ ...rule, body: { ...rule.body, id: 'sr_nope' } }] })],
    ['a duplicate rule id', JSON.stringify({ ...good, rules: [rule, rule] })],
    ['two rules for one sign-in', JSON.stringify({ ...good, rules: [rule, other] })],
    ['a terminal rule', JSON.stringify({ ...good, rules: [{ ...rule, body: { ...rule.body, surface: 'terminal' } }] })],
    ['a truncated file', JSON.stringify(good).slice(0, 80)],
  ];
};

describe('the standing rules file', () => {
  it('should write the document atomically in a private directory and read it back', async () => {
    const files = new MemoryFiles();
    const store = new FileSignInRuleStore(DIRECTORY, files);
    const document = await oneRule();
    await store.write(document);
    should(files.directories).eql([[DIRECTORY, 0o700]]);
    should(await store.read()).eql(document);
    should(await new FileSignInRuleStore('/state/none', files).read()).be.undefined();
  });

  it('should refuse every damaged document whole: zero rules, damaged, audited, never a default', async () => {
    for (const [name, text] of await damages()) {
      // Arrange
      const files = new MemoryFiles();
      files.files.set(FILE, text);
      const audits: unknown[] = [];
      const service = new SignInRuleService({
        store: new FileSignInRuleStore(DIRECTORY, files),
        accounts: { listing: async () => ({ accounts: [], signIns: [], keys: new Map() }) },
        proofs: new FakeProofs(),
        passkeys: { any: async () => true, of: async () => true },
        audit: { record: async entry => void audits.push(entry) },
        clock: { now: () => NOW },
        warn: () => undefined,
      });

      // Act
      const read = await new FileSignInRuleStore(DIRECTORY, files).read().then(
        () => 'parsed',
        () => 'refused',
      );
      await service.load();

      // Assert
      should([name, read]).eql([name, 'refused']);
      should(await service.list(HOST_OWNER)).eql({ health: 'damaged', rules: [], stages: [] });
      should(audits).have.length(1);
    }
  });

  it('should move a damaged file aside before the next write, keeping its text', async () => {
    // Arrange
    const files = new MemoryFiles();
    files.files.set(FILE, '{"v":1,"rules":[');
    const store = new FileSignInRuleStore(DIRECTORY, files);

    // Act
    await store.setAside('2026-11-01T12-00-00-000Z');
    await store.write({ v: 1, rules: [] });

    // Assert
    should(files.files.get(`${FILE}.damaged-2026-11-01T12-00-00-000Z`)).equal('{"v":1,"rules":[');
    should(JSON.parse(files.files.get(FILE) ?? '')).eql({ v: 1, rules: [] });
  });
});
