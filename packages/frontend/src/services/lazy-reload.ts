import { lazy, type Component } from 'solid-js';

const RELOAD_KEY = 'manifest:chunk-reload';

/**
 * Wrap a dynamic import with retry-via-reload. On import failure,
 * sets a sessionStorage flag and reloads the page. The flag prevents
 * infinite reload loops — if the reload itself fails, the error
 * propagates normally.
 */
export function lazyReload<T extends Component>(
  factory: () => Promise<{ default: T }>,
): ReturnType<typeof lazy<T>> {
  return lazy(() =>
    factory()
      .then((mod) => {
        sessionStorage.removeItem(RELOAD_KEY);
        return mod;
      })
      .catch((err: unknown) => {
        const alreadyReloaded = sessionStorage.getItem(RELOAD_KEY);
        if (!alreadyReloaded) {
          sessionStorage.setItem(RELOAD_KEY, '1');
          window.location.reload();
          return new Promise<{ default: T }>(() => {});
        }
        throw err;
      }),
  );
}
