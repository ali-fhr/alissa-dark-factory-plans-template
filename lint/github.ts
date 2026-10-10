// A read-only GitHub REST client for rule 5b (design loop-operator-surface §2.12, §8.1): GET only,
// through the same memoising reader as the Alissa one. GITHUB_TOKEN (or GH_TOKEN) is sent when set
// and never printed; without one the reads are anonymous, which reaches public repositories only.
// GITHUB_API_URL overrides https://api.github.com (GitHub Actions sets it).
import { type AlissaReader, httpReader } from "./alissa.ts";

export const DEFAULT_GITHUB_API = "https://api.github.com";

export function githubReader(env: NodeJS.ProcessEnv, opts: { retries?: number; timeoutMs?: number } = {}): AlissaReader {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
  return httpReader({
    base: env.GITHUB_API_URL || DEFAULT_GITHUB_API,
    ...(token ? { token } : {}),
    headers: { Accept: "application/vnd.github+json", "User-Agent": "plan-lint", "X-GitHub-Api-Version": "2022-11-28" },
    ...opts,
  });
}

/** `GET /repos/<owner>/<repo>`. */
export function repoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
}

/** `GET /repos/<owner>/<repo>/contents/<path>?ref=<branch>` — 200 for a file or a directory. */
export function contentsPath(repo: string, path: string, ref: string): string {
  return `${repoPath(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
}
