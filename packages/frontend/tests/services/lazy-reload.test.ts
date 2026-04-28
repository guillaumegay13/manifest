import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('solid-js', () => ({
  lazy: (factory: () => Promise<unknown>) => factory,
}));

import { lazyReload } from '../../src/services/lazy-reload.js';

const RELOAD_KEY = 'manifest:chunk-reload';

describe('lazyReload', () => {
  const reloadMock = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      value: { reload: reloadMock },
      writable: true,
      configurable: true,
    });
    reloadMock.mockReset();
  });

  it('passes through on successful import', async () => {
    const mod = { default: (() => null) as unknown as import('solid-js').Component };
    const factory = lazyReload(() => Promise.resolve(mod));
    const result = await (factory as unknown as () => Promise<typeof mod>)();
    expect(result).toBe(mod);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('clears the reload flag after a successful import', async () => {
    sessionStorage.setItem(RELOAD_KEY, '1');
    const mod = { default: (() => null) as unknown as import('solid-js').Component };
    const factory = lazyReload(() => Promise.resolve(mod));

    await (factory as unknown as () => Promise<typeof mod>)();

    expect(sessionStorage.getItem(RELOAD_KEY)).toBeNull();
  });

  it('reloads on first import failure', async () => {
    const factory = lazyReload(() => Promise.reject(new Error('chunk fail')));
    const promise = (factory as unknown as () => Promise<unknown>)();

    // The promise should never resolve (page is "reloading")
    const settled = await Promise.race([
      promise.then(() => 'resolved').catch(() => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 50)),
    ]);

    expect(settled).toBe('pending');
    expect(reloadMock).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RELOAD_KEY)).toBe('1');
  });

  it('propagates error on second failure and keeps the guard flag set', async () => {
    sessionStorage.setItem(RELOAD_KEY, '1');
    const factory = lazyReload(() => Promise.reject(new Error('still broken')));

    await expect(
      (factory as unknown as () => Promise<unknown>)(),
    ).rejects.toThrow('still broken');

    expect(reloadMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RELOAD_KEY)).toBe('1');
  });
});
