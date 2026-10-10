// A read-only Alissa REST client for rules 10–12 (design §5.5). GET only; the token is sent as a
// Bearer header and never printed. Answers are memoised per path for the run.

export interface Answer {
  status: number;
  body: unknown;
}

export interface AlissaReader {
  get(path: string): Promise<Answer>;
}

export class AlissaUnavailable extends Error {}

export interface HttpOptions {
  base: string;
  /** Sent as a Bearer header when present; the GitHub reader may run without one. */
  token?: string;
  /** Extra request headers (an `Accept` here replaces the JSON default). */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export function httpReader(opts: HttpOptions): AlissaReader {
  const base = opts.base.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 2;
  const delay = opts.retryDelayMs ?? 1000;
  const cache = new Map<string, Promise<Answer>>();

  async function once(path: string): Promise<Answer> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...opts.headers,
          },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
          redirect: "error",
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(delay * (attempt + 1));
          continue;
        }
        throw new AlissaUnavailable(`GET ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(delay * (attempt + 1));
        continue;
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: res.status, body };
    }
  }

  return {
    get(path: string): Promise<Answer> {
      let p = cache.get(path);
      if (!p) {
        p = once(path);
        cache.set(path, p);
      }
      return p;
    },
  };
}

/** The API's own error text, for a finding; never the request headers. */
export function describe(answer: Answer): string {
  const b = answer.body as { error?: unknown; message?: unknown } | null;
  const parts = [String(answer.status)];
  if (b && typeof b.error === "string") parts.push(b.error);
  if (b && typeof b.message === "string") parts.push(`— ${b.message}`);
  return parts.join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
