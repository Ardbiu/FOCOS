// A static file server behind `fetch`, serving the sample data set from memory.
// Tests use it so they never depend on the real pipeline output in public/data.
import { vi } from 'vitest';
import { buildSample } from '../../scripts/make-sample-data.mjs';
import { clearDataCache } from '../../src/data';

type Answer = Uint8Array | string | { status: number } | Error;
/** What a path answers with: a body, a status, a network error, or a function for an answer that arrives later. */
export type Served = Answer | (() => Promise<Answer>);

export interface SampleServer {
  /** Path under `data/` -> what to answer. Change it to simulate missing or broken files. */
  files: Map<string, Served>;
  /** Every path requested so far, in order. */
  requests: string[];
  /** How often one path was requested. */
  count(path: string): number;
  json<T = any>(path: string): T;
}

const sample: Map<string, Uint8Array> = buildSample();

/** Installs the server and clears the loaders' cache. Call from `beforeEach`; pair with `vi.unstubAllGlobals()`. */
export function serveSample(): SampleServer {
  const prefix = `${import.meta.env.BASE_URL}data/`;
  const files = new Map<string, Served>(sample);
  const requests: string[] = [];
  clearDataCache();
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    requests.push(path);
    const entry = files.get(path);
    const item = typeof entry === 'function' ? await entry() : entry;
    if (item === undefined) return new Response('not found', { status: 404 });
    if (item instanceof Error) throw item;
    if (typeof item === 'object' && 'status' in item) return new Response('', { status: item.status });
    return new Response(item as BodyInit);
  });
  return {
    files,
    requests,
    count: (path) => requests.filter((request) => request === path).length,
    json: (path) => JSON.parse(new TextDecoder().decode(sample.get(path))),
  };
}
