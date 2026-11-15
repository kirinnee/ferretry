import { describe, expect, it } from 'bun:test';
import {
  FERRETS_APP_HOOKS,
  FERRETS_LIST_SCOPE_HOOK,
  type FerretsListScope,
  isFerretsListScope,
} from '../../contract/index.ts';

const scope = (): FerretsListScope => ({
  subscribe: () => () => undefined,
  watch: () => () => undefined,
  snapshot: () => ({ scope: null, groupOf: () => null }),
  enter: () => undefined,
  exit: () => undefined,
  recover: () => undefined,
});

describe('the ferrets.list-scope app hook', () => {
  it('is declared under its name with the narrowing that reads a provided value', () => {
    expect(FERRETS_LIST_SCOPE_HOOK).toBe('ferrets.list-scope');
    expect(FERRETS_APP_HOOKS[FERRETS_LIST_SCOPE_HOOK]).toBe(isFerretsListScope);
  });

  it('accepts a provider with every part and refuses anything short of one', () => {
    expect(isFerretsListScope(scope())).toBe(true);
    for (const missing of ['subscribe', 'watch', 'snapshot', 'enter', 'exit', 'recover'] as const) {
      expect(isFerretsListScope({ ...scope(), [missing]: undefined })).toBe(false);
    }
    expect(isFerretsListScope(null)).toBe(false);
    expect(isFerretsListScope('scope')).toBe(false);
  });
});
