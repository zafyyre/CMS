import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type FetchHandler = (event: {
  request: {
    method: string;
    url: string;
    mode: string;
    headers: Headers;
  };
  respondWith: (response: Promise<Response> | Response) => void;
}) => void;

function loadWorker() {
  let fetchHandler: FetchHandler | undefined;
  const cache = {
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
  };

  const self = {
    location: { origin: 'https://league.test' },
    addEventListener: (type: string, handler: FetchHandler) => {
      if (type === 'fetch') fetchHandler = handler;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };

  vm.runInNewContext(readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8'), {
    self,
    caches: {
      open: vi.fn(async () => cache),
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
    },
    fetch: vi.fn(async () => new Response('online', { status: 200 })),
    URL,
    Response,
  });

  if (!fetchHandler) throw new Error('service worker did not register a fetch handler');
  const handler = fetchHandler;

  return {
    cache,
    async navigate(path: string) {
      let response: Promise<Response> | undefined;
      handler({
        request: {
          method: 'GET',
          url: `https://league.test${path}`,
          mode: 'navigate',
          headers: new Headers({ accept: 'text/html' }),
        },
        respondWith: (value) => {
          response = Promise.resolve(value);
        },
      });
      // A worker that deliberately does not handle a request leaves it to the
      // browser and Next.js, which is the desired behavior for private pages.
      return response ? await response : undefined;
    },
  };
}

describe('service-worker navigation cache', () => {
  it('stores only explicitly public pages', async () => {
    const worker = loadWorker();

    await worker.navigate('/admin');
    await worker.navigate('/admin/fixtures/fixture-1');
    await worker.navigate('/account');
    await worker.navigate('/sign-in/two-factor');

    expect(worker.cache.put).not.toHaveBeenCalled();
  });

  it('continues caching public navigations for offline use', async () => {
    const worker = loadWorker();

    expect(await worker.navigate('/schedule')).toBeInstanceOf(Response);

    expect(worker.cache.put).toHaveBeenCalledTimes(1);
  });
});
