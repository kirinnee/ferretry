import { implementApp } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { SearchSettings } from './settings.tsx';

/** Search (app half): the Web search settings tab. */
export default implementApp(manifest, {
  build: ({ client }) => ({
    settings: { search: () => createElement(SearchSettings, { client }) },
  }),
});
