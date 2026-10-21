// A read-only Alissa REST client for rules 10–12 (design §5.5) and K6. GET only; the token is sent
// as a Bearer header and never printed. Answers are memoised per path for the run. K7's and K8's
// POSTs — Studio's verify routes, reads that take their question as a body — go through `httpPoster`.

export interface Answer {
  status: number;
  body: unknown;
  /** How many requests the answer took (1 when the first one answered). */
  attempts?: number;
}

export interface AlissaReader {
  get(path: string): Promise<Answer>;
}

/** The API could not be reached at all, after every retry: a network error or a timeout. */
export class AlissaUnavailable extends Error {}

export interface HttpOptions {
  base: string;
  /** Sent as a Bearer header when present; the GitHub reader may run without one. */
  token?: string;
  /** Extra request headers (an `Accept` here replaces the JSON default). */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Retries after the first attempt (default 3: four attempts in all). */
  retries?: number;
  /** The first backoff wait; each later one doubles it (default 1000: 1 s, 2 s, 4 s). */
  retryDelayMs?: number;
  /** The most a run waits between attempts of one request, in all (default 60 s). */
  maxRetryWaitMs?: number;
  /** For tests: how a backoff wait is spent. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_MAX_RETRY_WAIT_MS = 60_000;
/** The least a RateLimit-derived wait lasts: one second, since `reset` rounds down (issue #17). */
export const MIN_RATELIMIT_RESET_MS = 1000;

/** An answer that says "retry me", not "no": a rate limit or a server error. */
export function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * `Retry-After` in milliseconds — delay-seconds or an HTTP date — or `null` when it is absent or
 * unreadable (the exponential backoff applies then).
 */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * The rate-limit window's reset in milliseconds, from the IETF RateLimit headers, or `null` when
 * neither gives one. Alissa sends the draft-7 `RateLimit: limit=60, remaining=0, reset=42`; the
 * draft-6 `RateLimit-Reset: 42` and the draft-8 `RateLimit: "default";r=0;t=42` are read too.
 * The value is delta-seconds; one large enough to be a Unix time (some servers send that) is read
 * as one. It is the fallback for a 429 that carries no `Retry-After`: without it the exponential
 * backoff (7 s in all) would spend every attempt inside the same 60 s window. The wait is never
 * under `MIN_RATELIMIT_RESET_MS`: `reset` is delta-seconds rounded down, so `reset=0` (or a Unix
 * reset already past) means "up to just under 1 s", and a 0 ms wait would spend the retries inside
 * the same window. An explicit `Retry-After: 0` is honoured as sent.
 */
export function rateLimitResetMs(headers: Headers, now: number = Date.now()): number | null {
  const fromField = (value: string | null): string | null => {
    if (value === null) return null;
    const m = /(?:^|[\s,;])(?:reset|t)\s*=\s*(\d+)\b/i.exec(value);
    return m ? m[1]! : null;
  };
  const raw = fromField(headers.get("ratelimit")) ?? headers.get("ratelimit-reset")?.trim() ?? null;
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  // A Unix time (seconds) rather than a delta: anything past 2001-09-09 is not a window length.
  const ms = n >= 1_000_000_000 ? n * 1000 - now : n * 1000;
  return Math.max(MIN_RATELIMIT_RESET_MS, ms);
}

/**
 * What a transient answer asks to be waited before the next attempt: its `Retry-After`, else, for
 * a 429, the RateLimit window's reset; `null` leaves the exponential backoff to decide.
 */
export function hintedWaitMs(res: { status: number; headers: Headers }, now: number = Date.now()): number | null {
  const after = retryAfterMs(res.headers.get("retry-after"), now);
  if (after !== null) return after;
  return res.status === 429 ? rateLimitResetMs(res.headers, now) : null;
}

/** A POST whose answer is a read: Studio's `POST /v1/factory/repo-files/verify` (K7) and `POST /v1/factory/url-cites/verify` (K8). */
export interface AlissaPoster {
  post(path: string, body: unknown): Promise<Answer>;
}

/**
 * One request with bounded retry: a network error, a timeout, a 429 or a 5xx is retried with
 * exponential backoff (`retryDelayMs`, doubling), or after the answer's `Retry-After` when it gives
 * one (a 429 without one: after its RateLimit window's reset, `rateLimitResetMs`), until `retries` are spent or the next wait would take the request past `maxRetryWaitMs` of
 * waiting. A transient answer that outlasts the retries is returned as it is (callers read
 * `isTransient`); a network error that outlasts them throws `AlissaUnavailable`.
 */
function requester(opts: HttpOptions): (method: "GET" | "POST", path: string, body?: unknown) => Promise<Answer> {
  const base = opts.base.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const delay = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const budget = opts.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS;
  const wait = opts.sleepImpl ?? sleep;

  return async function once(method, path, body): Promise<Answer> {
    let waited = 0;
    /** Wait before the next attempt; `false` when no attempt is left or the wait is over budget. */
    const backoff = async (attempt: number, hinted: number | null): Promise<boolean> => {
      if (attempt >= retries) return false;
      const ms = hinted ?? delay * 2 ** attempt;
      if (waited + ms > budget) return false;
      waited += ms;
      await wait(ms);
      return true;
    };
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: {
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...opts.headers,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
          redirect: "error",
        });
      } catch (err) {
        if (await backoff(attempt, null)) continue;
        const tries = attempt + 1;
        throw new AlissaUnavailable(`${method} ${path} failed after ${tries} attempt(s): ${err instanceof Error ? err.message : String(err)}`);
      }
      if (isTransient(res.status) && (await backoff(attempt, hintedWaitMs(res)))) {
        await res.body?.cancel();
        continue;
      }
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed, attempts: attempt + 1 };
    }
  };
}

export function httpReader(opts: HttpOptions): AlissaReader {
  const once = requester(opts);
  const cache = new Map<string, Promise<Answer>>();
  return {
    get(path: string): Promise<Answer> {
      let p = cache.get(path);
      if (!p) {
        p = once("GET", path);
        cache.set(path, p);
      }
      return p;
    },
  };
}

/** No memo: K7 and K8 each post once per run. */
export function httpPoster(opts: HttpOptions): AlissaPoster {
  const once = requester(opts);
  return { post: (path, body) => once("POST", path, body) };
}

/** The API's own error text, for a finding; never the request headers. */
export function describe(answer: Answer): string {
  const b = answer.body as { error?: unknown; message?: unknown } | null;
  const parts = [String(answer.status)];
  if (b && typeof b.error === "string") parts.push(b.error);
  if (b && typeof b.message === "string") parts.push(`— ${b.message}`);
  if (answer.attempts !== undefined && answer.attempts > 1) parts.push(`(after ${answer.attempts} attempts)`);
  return parts.join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
