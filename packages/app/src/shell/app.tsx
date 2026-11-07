import { RouterProvider } from '../router/router.tsx';
import { type ShellProviderProps, ShellProvider, useShell } from './context.tsx';
import { Frame } from './frame.tsx';

function Routed() {
  const { routes } = useShell();
  return (
    <RouterProvider parseRoute={routes.parse}>
      <Frame />
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
