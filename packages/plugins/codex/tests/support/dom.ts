/**
 * A happy-dom registration for the codex suites that render with React.
 *
 * Take `createRoot` from HERE and never import `react-dom/client` statically in a test file. Bun's unit tier runs
 * every package's files in ONE process and its module cache is shared: `react-dom` reads `window`/`document` once,
 * when it first loads (`canUseDOM`, input-event support), and keeps that answer for every later suite. A static
 * `import … from 'react-dom/client'` is loaded BEFORE a side-effect import that sits above it (Bun does not keep
 * a package import behind a local module), so it froze React DOM as "no DOM" for the whole process, and every suite
 * after it that typed into an input (the app's picker combobox and command bar, the packs settings fields) saw
 * `onChange` never fire. The dynamic import below runs after the registration, which is the only order that holds.
 * The registration is the shared `__ferretryDomRegistered` one, because happy-dom refuses a second.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const registered = globalThis as typeof globalThis & { __ferretryDomRegistered?: boolean };
if (!registered.__ferretryDomRegistered) {
  GlobalRegistrator.register({ url: 'https://pwa.example.test/' });
  registered.__ferretryDomRegistered = true;
}
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');

export { createRoot };
