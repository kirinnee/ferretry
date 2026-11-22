import { describe, expect, it } from 'bun:test';
import { mount, must } from '@ferretry/app/testing';
import { AddProjectForm } from '../../../app/views/add-project-form.tsx';
import {
  BROAD_ROOT_WARNING,
  emptyProjectRegistrationDraft,
  type ProjectRegistrationDraft,
} from '../../../app/lib/registration-model.ts';

const draft = (patch: Partial<ProjectRegistrationDraft>): ProjectRegistrationDraft => ({
  ...emptyProjectRegistrationDraft,
  ...patch,
});
const form = (patch: Partial<ProjectRegistrationDraft>) => (
  <AddProjectForm draft={draft(patch)} onDraftChange={() => {}} onSubmit={() => {}} onCancel={() => {}} status={null} />
);

describe('AddProjectForm: the broad-root warning (F6061 U4)', () => {
  it('warns, before Register is pressed, when the folder typed is the disk or a home', async () => {
    for (const path of ['/', '/home', '/Users/sam']) {
      const mounted = await mount(form({ path }));
      const warning = must(mounted.container.querySelector('[data-project-broad-warning]'), `the warning for ${path}`);
      expect(warning.textContent).toContain(BROAD_ROOT_WARNING);
      expect(warning.getAttribute('role')).toBe('status');
      await mounted.unmount();
    }
  });

  it('says nothing for an ordinary folder, and nothing for a folder that is only being cloned or created into', async () => {
    for (const patch of [
      { path: '/srv/work' },
      { path: '/home/sam/code' },
      { path: '/home', mode: 'clone' as const, url: 'https://github.com/o/r.git' },
      { path: '/home', mode: 'new-folder' as const },
    ]) {
      const mounted = await mount(form(patch));
      expect(mounted.container.querySelector('[data-project-broad-warning]')).toBeNull();
      await mounted.unmount();
    }
  });
});
