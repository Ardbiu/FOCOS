// A static file server behind `fetch` that reads web/public/data from disk.
// Only for throwaway checks against the real pipeline output; committed tests
// use the sample server instead.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { clearDataCache } from '../../src/data';

export function serveRealData(): { requests: string[] } {
  const dir = join(process.cwd(), 'public', 'data');
  const prefix = `${import.meta.env.BASE_URL}data/`;
  const requests: string[] = [];
  clearDataCache();
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    requests.push(path);
    const file = join(dir, path);
    if (!existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(readFileSync(file)) as BodyInit);
  });
  return { requests };
}
