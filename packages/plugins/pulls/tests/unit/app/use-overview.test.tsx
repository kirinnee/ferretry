import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { ListClient } from '../../../app/features/list/api.ts';
import { useOverview } from '../../../app/features/list/use-overview.ts';
import { overview } from '../../fixtures/pulls-list-views.ts';

let open: Mounted | undefined;
afterEach(async () => {
  await open?.unmount();
  open = undefined;
});

/** A daemon that answers every overview read and remembers whether each one was marked as a person's press. */
const recording = () => {
  const marks: Array<boolean | undefined> = [];
  const client: ListClient = {
    call: (async (route: string, init?: { quiet?: boolean }) => {
      if (route === 'GET /v1/projects') return [];
      marks.push(init?.quiet);
      return overview();
    }) as ListClient['call'],
  };
  return { client, marks };
};

function Probe({ client }: { readonly client: ListClient }) {
  const { reading, reload, refresh } = useOverview(client);
  return (
    <div>
      <span data-status>{reading.status}</span>
      <button type="button" data-reload onClick={reload} />
      <button type="button" data-refresh onClick={refresh} />
    </div>
  );
}

const press = async (selector: string): Promise<void> =>
  await interact(() => must(open?.container.querySelector<HTMLButtonElement>(selector), selector).click());

describe('the PRs overview read', () => {
  it('marks only Try again as a person’s press; the page’s own re-read (a watch saved) stays quiet', async () => {
    const { client, marks } = recording();
    open = await mount(<Probe client={client} />);
    await settleUntil(() => marks.length === 1, 'the opening read', interact);
    await press('[data-refresh]');
    await settleUntil(() => marks.length === 2, 'the quiet re-read', interact);
    await press('[data-reload]');
    await settleUntil(() => marks.length === 3, 'the Try again read', interact);
    await press('[data-refresh]');
    await settleUntil(() => marks.length === 4, 'a quiet re-read after the press', interact);
    // `true` = the page's own (quiet); `false` = the person's press, spent on that one read only.
    expect(marks).toEqual([true, true, false, true]);
  });
});
