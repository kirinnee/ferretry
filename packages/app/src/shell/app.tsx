import { RouterProvider } from '../router/router.tsx';
import { type ShellProviderProps, ShellProvider, useShell } from './context.tsx';
import { ChosenNameSaver } from './chosen-name-saver.tsx';
import { Frame } from './frame.tsx';
import { LoadingBarHost } from '../ui/loading.tsx';
import { NotificationTaps } from './notification-taps.tsx';

function Routed() {
  const { routes, runtime } = useShell();
  return (
    <RouterProvider parseRoute={routes.parse} onAddress={runtime.addressChanged}>
      <Frame />
      {/* The name typed on the pair screen is saved on whatever route comes next (the first run names no machine). */}
      <ChosenNameSaver />
      {/* The ONE background-loading bar (ui/loading.tsx): fixed to the top of the window, so it moves nothing. */}
      <LoadingBarHost />
      {/* A tap on a notification is routed in the app, never by reloading it (S6). */}
      {runtime.notificationOpens === undefined ? null : <NotificationTaps inbox={runtime.notificationOpens} />}
    </RouterProvider>
  );
}

/** The whole app: the shell model, the router over the compiled screens, and the frame. */
export function App(props: Omit<ShellProviderProps, 'children'>) {
  return (
    <ShellProvider {...props}>
      <Routed />
    </ShellProvider>
  );
}
