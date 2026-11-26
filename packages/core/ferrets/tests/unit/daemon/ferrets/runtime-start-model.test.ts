import { expect, test } from 'bun:test';
import type { StartRequest } from '../../../../contract/index.ts';
import { withRuntimeModel } from '../../../../daemon/lib/ferrets/runtime-records.ts';

const request: StartRequest = { folder: '/work', by: 'owner' };

test("a start records the runtime's selected model, unless there is none or the caller chose one", () => {
  expect(withRuntimeModel(request, 'provider/model')).toEqual({ ...request, options: { model: 'provider/model' } });
  expect(withRuntimeModel({ ...request, options: { effort: 'high' } } as StartRequest, 'provider/model')).toEqual({
    ...request,
    options: { effort: 'high', model: 'provider/model' },
  });
  expect(withRuntimeModel(request, undefined)).toBe(request);
  const chosen = { ...request, options: { model: 'caller/model' } } as StartRequest;
  expect(withRuntimeModel(chosen, 'provider/model')).toBe(chosen);
});
