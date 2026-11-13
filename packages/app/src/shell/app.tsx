import { RouterProvider } from '../router/router.tsx';
import { type ShellProviderProps, ShellProvider, useShell } from './context.tsx';
import { Frame } from './frame.tsx';
import { NotificationTaps } from './notification-taps.tsx';

function Routed() {
  const { routes, runtime } = useShell();
  return (
    <RouterProvider parseRoute={routes.parse} onAddress={runtime.addressChanged}>
      <Frame />
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
