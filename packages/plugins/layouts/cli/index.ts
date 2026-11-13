import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import type { CurrentLayout, LayoutList, LayoutSummary, ThemeList } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { currentLines, layoutLines, listLines, themeLines } from './lib/render.ts';

const OK = 0;
const USAGE = 2;

/** A layout for one device is the app's own saved choice (§5.3, §9.4): the daemon keeps none, so `fy` cannot set it. */
export const DEVICE_SENTENCE =
  'a layout or theme for one device is chosen in the app on that device (Settings, Layout). From here fy changes it for all your devices, so leave out --device.';

const wantsJson = (invocation: VerbInvocation): boolean => invocation.options.json === true;

/**
 * Layouts (cli half, §5.3): `fy layout …` and `fy theme …`. Each verb is one daemon call; the daemon checks the
 * change, writes `config/layout.yaml` and tells every open app. Write positionals before options.
 */
export default implementCli(manifest, {
  build: ({ client, io }) => {
    const usage = (line: string): number => {
      io.err(`usage: ${line}`);
      return USAGE;
    };
    const forEveryDevice = (invocation: VerbInvocation): boolean => {
      if (invocation.options.device === undefined) return true;
      io.err(DEVICE_SENTENCE);
      return false;
    };
    const print = (value: unknown, lines: readonly string[], invocation: VerbInvocation): void => {
      if (wantsJson(invocation)) io.out(JSON.stringify(value));
      else for (const line of lines) io.out(line);
    };

    return {
      verbs: {
        'layout show': async invocation => {
          const current = await client.call<CurrentLayout>('GET /v1/layouts/current');
          print(current, currentLines(current), invocation);
          return OK;
        },

        'layout list': async invocation => {
          const list = await client.call<LayoutList>('GET /v1/layouts');
          print(list, listLines(list), invocation);
          return OK;
        },

        'layout set': async invocation => {
          const [path, ...rest] = invocation.args;
          if (path === undefined || rest.length === 0)
            return usage('fy layout set <path> <value>   e.g. fy layout set nav.side right');
          if (!forEveryDevice(invocation)) return USAGE;
          const answer = await client.call<{ current: CurrentLayout['layout'] }>('PATCH /v1/layouts/current', {
            body: { changes: [{ path, value: rest.join(',') }] },
          });
          print(answer, layoutLines(answer.current), invocation);
          return OK;
        },

        'layout use': async invocation => {
          const [layout] = invocation.args;
          if (layout === undefined) return usage('fy layout use <name>');
          if (!forEveryDevice(invocation)) return USAGE;
          const answer = await client.call<{ current: CurrentLayout['layout'] }>('PUT /v1/layouts/current', {
            body: { layout },
          });
          print(answer, [`now using the ${answer.current.id} layout`], invocation);
          return OK;
        },

        'layout reset': async invocation => {
          if (!forEveryDevice(invocation)) return USAGE;
          const answer = await client.call<{ current: CurrentLayout['layout'] }>('POST /v1/layouts/reset');
          print(answer, ['your changes are dropped; using the built-in default layout'], invocation);
          return OK;
        },

        'layout save': async invocation => {
          const [id] = invocation.args;
          if (id === undefined) return usage('fy layout save <name>');
          const saved = await client.call<LayoutSummary>('POST /v1/layouts', { body: { id } });
          print(saved, [`saved the layout in use as ${saved.id}`], invocation);
          return OK;
        },

        'theme list': async invocation => {
          const list = await client.call<ThemeList>('GET /v1/layouts/themes');
          print(list, themeLines(list), invocation);
          return OK;
        },

        'theme use': async invocation => {
          const [theme] = invocation.args;
          if (theme === undefined) return usage('fy theme use <name>');
          if (!forEveryDevice(invocation)) return USAGE;
          const answer = await client.call<{ current: { id: string } }>('PUT /v1/layouts/theme', { body: { theme } });
          print(answer, [`now using the ${answer.current.id} theme`], invocation);
          return OK;
        },
      },
    };
  },
});
