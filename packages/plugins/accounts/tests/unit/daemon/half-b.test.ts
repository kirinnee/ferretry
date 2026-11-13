import { describe, it } from 'bun:test';
import { DevicesChanged } from '@ferretry/plugin-access/contract';
import should from 'should';
import { halfB } from '../../../daemon/half-b.ts';
import manifest from '../../../manifest.ts';

/** Half b's piece of the daemon half: every key it hands the composition root is one the manifest declares. */

const built = halfB({
  rules: {} as never,
  suggestions: {} as never,
  plans: {} as never,
  phone: {} as never,
  copies: {} as never,
  pasteRules: {} as never,
  pasteRuleStages: {} as never,
});

describe('halfB', () => {
  it('should serve only declared routes, each once', () => {
    const declared = new Set(manifest.actions.routes.map(route => route.key as string));
    const keys = Object.keys(built.routes);
    should(keys.filter(key => !declared.has(key))).eql([]);
    should(keys.length).be.above(30);
  });

  it('should move every ferret-scoped route under /v1/ferrets/:ferretId (design §1.4)', () => {
    should(Object.keys(built.routes).filter(key => key.includes('/v1/sessions/'))).eql([]);
    should(Object.keys(built.routes)).containEql('GET /v1/ferrets/:ferretId/copies');
  });

  it('should register the sign-in-approval ask source the manifest takes, and subscribe to Access’s DevicesChanged', () => {
    const takes = manifest.hooks.takes.map(take => `${take.hook.name}:${String(take.key)}`);
    should(takes).containEql('ask.sources:sign-in-approval');
    should(Object.keys(built.hooks)).eql(['ask.sources:sign-in-approval', 'input.phone-approval:phone']);
    should(takes).containEql('input.phone-approval:phone');
    should(Object.keys(built.subscribers)).eql([DevicesChanged.name, 'ferrets.changed']);
    should(manifest.data.subscribes.map(event => event.name)).containEql(DevicesChanged.name);
  });
});
