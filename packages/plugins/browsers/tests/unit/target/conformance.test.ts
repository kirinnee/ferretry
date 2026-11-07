import { describe, expect, test } from 'bun:test';
import type { InputTargetAdapter, InputTargetField } from '@ferretry/core-vault/contract';
import {
  type InputTargetSubject,
  inputTargetConformance,
  type LiveInputTarget,
  liveTargetCases,
  liveTargetFailure,
} from '@ferretry/core-vault/contract/testing';
import { type PageInputHost, PageInputTarget } from '../../../daemon/target/adapter.ts';
import type { ElementTarget } from '../../../daemon/target/lib/element.ts';
import { workerInputFields } from '../../../daemon/target/lib/worker-port.ts';
import { type InputWorkerPages, serveInputMethod } from '../../../daemon/target/lib/worker-serve.ts';
import { FakeWorld } from '../../support/page-world.ts';

/** The live page's key: the name a ferret's card names it by. */
const LIVE = 'live';

/** A JSON round trip, as every request and answer of the page input seam crosses the worker's wire. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The suite names its one field `value` and points at nothing; a ferret's card always points its field at an element
 * (a ref or a selector), and the page target refuses one that does not (`unsupported`). This supplies that pointer and
 * passes everything else through to the page target unchanged.
 */
function pointed(adapter: PageInputTarget, pointers: Readonly<Record<string, ElementTarget>>): InputTargetAdapter {
  const withPointers = (fields: readonly InputTargetField[]): InputTargetField[] =>
    fields.map(field => {
      const element = field.element ?? pointers[field.id];
      return element === undefined ? field : { ...field, element };
    });
  return {
    masking: adapter.masking,
    observe: async (ferret, target, fields) => await adapter.observe(ferret, target, withPointers(fields)),
    refind: async (ferret, target, fields, expected) =>
      await adapter.refind(ferret, target, withPointers(fields), expected),
    type: async (ferret, target, values, submit, expected, options) =>
      await adapter.type(ferret, target, values, submit, expected, options),
  };
}

/**
 * The page target over ONE live page whose password field is `#value`, end to end through Browsers' own code: the
 * page target (`adapter.ts`), the daemon's side of the seam (`worker-port.ts`), the worker's side (`worker-serve.ts`)
 * and the field checks (`fields.ts`) that bind a write to the document and the node the card showed. Only the page
 * and its DevTools sessions are fake (`../../support/page-world.ts`). A binding changes the way a real page does: a
 * navigation loads another document; a re-render puts a new node behind the same selector.
 */
function livePage(): InputTargetSubject {
  const world = new FakeWorld();
  let field = world.element('#value', 12, ['type', 'password', 'name', 'pw', 'autocomplete', 'current-password']);
  const pageId = world.subject.pageId;
  const pages: InputWorkerPages = {
    subject: id => {
      if (id !== pageId) throw new Error('that page is gone');
      return world.subject;
    },
    session: async () => world.session('page-target'),
    pushPage: () => {
      throw new Error('no push number is read here');
    },
  };
  const port = workerInputFields(async (method, params) => wire(await serveInputMethod(pages, method, wire(params))));
  const host: PageInputHost = {
    inputOnPage: async (_ferret, key, work) => {
      if (key !== LIVE) throw new Error('no such page in this session');
      return await work(port, pageId);
    },
  };
  const live: LiveInputTarget = {
    key: LIVE,
    change: binding => {
      if (binding === 'document') world.loaderId = 'loader-2';
      if (binding === 'element') field = world.rerender(field, 13);
    },
    writes: () => [...world.sessions.values()].reduce((sum, session) => sum + session.count('Input.insertText'), 0),
  };
  return {
    adapter: pointed(new PageInputTarget(host), { value: { kind: 'selector', selector: '#value' } }),
    unknownKey: 'nowhere',
    kind: 'page',
    live,
  };
}

inputTargetConformance('the page input target', livePage);

describe('the page input target, case by case against a live page', () => {
  for (const which of liveTargetCases('page'))
    test(`types ${which === 'unchanged' ? 'once into an unchanged page' : `nothing once ${which} ${which === 'proceed-refused' ? 'says no' : 'changed'}`}`, async () => {
      expect(await liveTargetFailure(livePage(), which)).toBeUndefined();
    });
});
