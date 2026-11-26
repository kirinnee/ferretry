import { describe, it } from 'bun:test';
import should from 'should';
import { observeInputFields, typeInputFields } from '../../../daemon/target/lib/fields.ts';
import type { BrowserInputFacts } from '../../../daemon/target/lib/contracts.ts';
import { FakeWorld } from '../../support/page-world.ts';

/**
 * E-312: the form a field belongs to, proved again at the write (#2406), in a file of its own. The two cases the larger
 * `fields.test.ts` never states by themselves: a form whose identity did NOT change is typed into, and a label that was
 * read as empty (a field with no label) is not a label that could not be read.
 */
const FORM = { id: 'login', name: 'login-form', action: 'https://app.example.test/session' };
const CODE = ['type', 'text', 'name', 'otp', 'autocomplete', 'one-time-code'];
const SECRET = 'synthetic-form-target-value';

const select = (selector: string) => ({ id: selector, target: { kind: 'selector' as const, selector } });

async function looked(world: FakeWorld): Promise<BrowserInputFacts> {
  const result = await observeInputFields(world.subject, [select('#code')]);
  if (!result.ok) throw new Error(`not observed: ${JSON.stringify(result)}`);
  return result.facts;
}

const typeCode = async (world: FakeWorld, facts: BrowserInputFacts) =>
  await typeInputFields(world.subject, facts, [{ field: '#code', text: SECRET }], false);

const insertions = (world: FakeWorld): number =>
  [...world.sessions.values()].reduce((sum, session) => sum + session.count('Input.insertText'), 0);

function worldWith(label: string, form: typeof FORM | null) {
  const world = new FakeWorld();
  const code = world.element('#code', 31, CODE);
  code.label = label;
  code.form = form === null ? null : { ...form };
  return { world, code };
}

describe('a form whose identity did not change', () => {
  it('should be typed into, once, when its id, name and action read exactly as they did at the look', async () => {
    const { world } = worldWith('Verification code', FORM);
    const facts = await looked(world);

    should(await typeCode(world, facts)).equal('typed');
    should(insertions(world)).equal(1);
  });

  it('should be typed into when the same form is rebuilt with equal facts (a new object, the same identity)', async () => {
    const { world, code } = worldWith('Verification code', FORM);
    const facts = await looked(world);
    code.form = { ...FORM };

    should(await typeCode(world, facts)).equal('typed');
    should(insertions(world)).equal(1);
  });

  it('should stay refused the moment any one of the three facts differs, with the others unchanged', async () => {
    for (const changed of [{ id: 'other' }, { name: 'other' }, { action: 'https://app.example.test/elsewhere' }]) {
      const { world, code } = worldWith('Verification code', FORM);
      const facts = await looked(world);
      code.form = { ...FORM, ...changed };

      should(await typeCode(world, facts)).equal('target_changed');
      should(insertions(world)).equal(0);
    }
  });
});

describe('a field with no form, and a field with no label, are not fields that could not be read', () => {
  it('should be typed into when it had no form at the look and has none at the write', async () => {
    const { world } = worldWith('Verification code', null);
    const facts = await looked(world);
    should(facts.fields[0]?.unread).be.undefined();
    should(facts.fields[0]?.field.formAction).be.undefined();

    should(await typeCode(world, facts)).equal('typed');
  });

  it('should be refused when a form owns it at the write that did not at the look', async () => {
    const { world, code } = worldWith('Verification code', null);
    const facts = await looked(world);
    code.form = { ...FORM };

    should(await typeCode(world, facts)).equal('target_changed');
    should(insertions(world)).equal(0);
  });

  it('should be typed into when it had no label at the look and still has none (absent is an empty label, read)', async () => {
    const { world } = worldWith('', FORM);
    const facts = await looked(world);
    should(facts.fields[0]?.unread).be.undefined();
    should(facts.fields[0]?.field.label).be.undefined();

    should(await typeCode(world, facts)).equal('typed');
    should(insertions(world)).equal(1);
  });

  it('should be refused when its label could not be read at the look, even though the write could read it (unread is never proved the same)', async () => {
    // no form and no label either way: the unread flag is the only thing that differs from a field that was read
    const { world, code } = worldWith('', null);
    code.readFails = true;
    const facts = await looked(world);
    should(facts.fields[0]?.unread).equal(true);
    delete code.readFails;

    should(await typeCode(world, facts)).equal('target_changed');
    should(insertions(world)).equal(0);
  });

  it('should be refused when its label was read as empty at the look and cannot be read at the write', async () => {
    const { world, code } = worldWith('', FORM);
    const facts = await looked(world);
    code.readFails = true;

    should(await typeCode(world, facts)).equal('target_changed');
    should(insertions(world)).equal(0);
  });
});
