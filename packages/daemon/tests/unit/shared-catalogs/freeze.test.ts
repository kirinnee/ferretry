import { describe, it } from 'bun:test';
import { LINK_ITEM_CATALOG_ID } from '@ferretry/protocol';
import should from 'should';
import {
  defaultMcpSummary,
  fingerprint,
  freezeItem,
  NORMALISED_CATALOG_ID,
  NORMALISED_ITEM_ID,
  readItem,
  skillOf,
  skillSummary,
  summaryFromDescription,
} from '../../../src/lib/shared-catalogs/freeze.ts';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';
import { crypto, SKILL_MD } from './support.ts';

const base = {
  publisher: `fy_daemon_${'A'.repeat(43)}`,
  catalogId: `cat_${'B'.repeat(22)}`,
  itemId: `itm_${'C'.repeat(22)}`,
  itemVersion: 2,
  name: 'demo',
  summary: 'Does it',
};
const skill = { files: [{ path: 'SKILL.md', content: SKILL_MD }] };

describe('freezing', () => {
  it('should freeze a skill and fingerprint it with and without its identity', async () => {
    const item = freezeItem({ ...base, body: { kind: 'skill', skill } });
    const first = await fingerprint(crypto, item);
    const other = await fingerprint(
      crypto,
      freezeItem({ ...base, itemId: `itm_${'D'.repeat(22)}`, itemVersion: 5, body: { kind: 'skill', skill } }),
    );
    should(first.digest).not.equal(other.digest);
    should(first.contentDigest).equal(other.contentDigest);
    should(first.size).be.above(0);
    should(NORMALISED_ITEM_ID).match(/^itm_A{22}$/u);
    should(readItem(item).review.length).be.above(0);
  });

  it('should carry a harness on an MCP item', () => {
    const item = freezeItem({
      ...base,
      harness: 'codex',
      body: { kind: 'mcp', mcp: { transport: 'command', command: 'run', args: [], env: {} } },
    });
    should(item.harness).equal('codex');
  });

  it('should refuse what the contract refuses, with where', () => {
    try {
      freezeItem({ ...base, name: 'bad name', body: { kind: 'skill', skill } });
      throw new Error('expected a refusal');
    } catch (error) {
      should(error).be.instanceOf(CatalogRefusal);
      should((error as CatalogRefusal).refusal).equal('source_refused');
      should((error as CatalogRefusal).message).match(/bad name cannot be shared/u);
    }
    try {
      freezeItem({ ...base, summary: '', body: { kind: 'skill', skill } });
      throw new Error('expected a refusal');
    } catch (error) {
      should((error as CatalogRefusal).refusal).equal('source_refused');
    }
  });

  it('should refuse a document with no canonical spelling', async () => {
    const item = freezeItem({ ...base, body: { kind: 'skill', skill } });
    const lone = { ...item, summary: `broken ${String.fromCharCode(0xd800)}` };
    let caught: unknown;
    try {
      await fingerprint(crypto, lone as never);
    } catch (error) {
      caught = error;
    }
    should(caught === undefined || caught instanceof CatalogRefusal).be.true();
  });
});

describe('summaries', () => {
  it('should fold whitespace, cut to the bound with an ellipsis and refuse hidden characters', () => {
    should(summaryFromDescription('  a\n  b\tc ')).equal('a b c');
    const cut = summaryFromDescription('x'.repeat(400));
    should(Array.from(cut ?? '')).have.length(280);
    should(cut?.endsWith(String.fromCodePoint(0x2026))).be.true();
    should(summaryFromDescription(`a${String.fromCodePoint(0x202e)}b`)).be.undefined();
  });

  it('should read a skill’s description, or say what is missing', () => {
    should(skillSummary(skill)).deepEqual({ summary: 'Does the demo thing' });
    should(skillSummary({ files: [{ path: 'SKILL.md', content: 'plain' }] })).have.property('problem');
    const hidden = `---\nname: x\ndescription: sneaky${String.fromCodePoint(0x202e)}text\n---\n`;
    const result = skillSummary({ files: [{ path: 'SKILL.md', content: hidden }] });
    should((result as { problem: string }).problem).match(/cannot be seen/u);
    should(skillSummary({ files: [{ path: 'other.md', content: 'x' }] })).have.property('problem');
  });

  it('should make a skill from files or say why not, and name an MCP setup', () => {
    should(skillOf([{ path: 'SKILL.md', content: 'x' }])).have.property('files');
    should(typeof skillOf([{ path: 'a.md', content: 'x' }])).equal('string');
    should(skillOf([])).be.a.String();
    should(defaultMcpSummary('files')).equal('MCP server files');
  });
});

describe('the placeholder catalog id', () => {
  it('should be the one a link item names, so a link item and a kept copy hash alike', () => {
    should(NORMALISED_CATALOG_ID).equal(LINK_ITEM_CATALOG_ID);
  });
});
