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

type InstallHandler = (event: { waitUntil: (work: Promise<unknown>) => void }) => void;

function loadWorker({ responseHeaders }: { responseHeaders?: HeadersInit } = {}) {
  let fetchHandler: FetchHandler | undefined;
  let installHandler: InstallHandler | undefined;
  const cache = {
    add: vi.fn<(request: Request) => Promise<void>>(async () => undefined),
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
  };

  const self = {
    location: { origin: 'https://league.test' },
    addEventListener: (type: string, handler: FetchHandler | InstallHandler) => {
      if (type === 'fetch') fetchHandler = handler as FetchHandler;
      if (type === 'install') installHandler = handler as InstallHandler;
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
    fetch: vi.fn(async () => new Response('online', { status: 200, headers: responseHeaders })),
    URL,
    // A worker resolves a relative address against its own origin; Node's
    // Request, having no origin, would throw instead.
    Request: class extends Request {
      constructor(input: string, init?: RequestInit) {
        super(new URL(input, self.location.origin), init);
      }
    },
    Response,
  });

  if (!fetchHandler) throw new Error('service worker did not register a fetch handler');
  const handler = fetchHandler;

  return {
    cache,
    async install() {
      let work: Promise<unknown> | undefined;
      installHandler?.({ waitUntil: (value) => (work = value) });
      await work;
    },
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

  it('never stores a page rendered for a signed-in visitor', async () => {
    // Every page's header shows the visitor's account controls, and the cache
    // is keyed by address alone: stored, this page would be shown offline to
    // the next person on the phone. The server marks such responses.
    const worker = loadWorker({ responseHeaders: { 'x-personalized': '1' } });

    expect(await worker.navigate('/standings')).toBeInstanceOf(Response);

    expect(worker.cache.put).not.toHaveBeenCalled();
  });

  it('precaches the offline page without the visitor’s cookies', async () => {
    const worker = loadWorker();

    await worker.install();

    expect(worker.cache.add).toHaveBeenCalledTimes(1);
    const request = worker.cache.add.mock.calls[0]?.[0];
    expect(request?.url).toBe('https://league.test/offline');
    expect(request?.credentials).toBe('omit');
  });
});
