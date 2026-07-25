import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { hostname } from "node:os";
import { Git } from "./git.ts";

export type Dest =
  | { kind: "local"; url: string; path: string }
  | { kind: "ssh"; url: string; host: string; path: string }
  | { kind: "other"; url: string };

export type RepoInfo = {
  /** Main repo root - the worktree that owns .git, even when CWD is a linked worktree. */
  root: string;
  /** The worktree we are actually standing in. */
  worktree: string;
  /** Absolute path of the common git dir. */
  commonDir: string;
  /** True when CWD is a linked worktree rather than the main one. */
  linked: boolean;
  /**
   * Snapshot ref discriminator, always two components: "<host>/<worktree>".
   * `<worktree>` is `_main` for the main worktree, else git's own worktree id.
   */
  snapKey: string;
  git: Git;
};

/** Ref names forbid ~ ^ : ? * [ \ and space, so anything odd becomes a dash. */
function refSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+|\.+$/g, "") || "unknown";
}

export function shortHost(): string {
  return refSafe(hostname().split(".")[0] ?? "unknown");
}

/**
 * Resolve the repo containing `cwd`.
 *
 * Uses --git-common-dir rather than --show-toplevel so a linked worktree maps to
 * its MAIN repo: the destination holds one bare repo per repo, never a duplicate
 * per worktree. Worktrees therefore share branches and tags, but each gets its
 * own snapshot buckets, because uncommitted work is inherently per-worktree.
 */
export async function findRepo(cwd = process.cwd()): Promise<RepoInfo | null> {
  const probe = new Git(cwd);
  const commonDir = await probe.tryOut("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (commonDir === null) return null;
  const worktree = await probe.tryOut("rev-parse", "--path-format=absolute", "--show-toplevel");
  if (worktree === null) return null;
  const gitDir = await probe.tryOut("rev-parse", "--path-format=absolute", "--absolute-git-dir");

  const root = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
  const linked = resolve(root) !== resolve(worktree);

  // For a linked worktree the git dir is <common>/worktrees/<id>, and that id is
  // unique per repo because git itself enforces it - a better key than the
  // directory basename, which two worktrees could share.
  const worktreeId = linked && gitDir ? refSafe(basename(gitDir)) : "_main";

  return {
    root,
    worktree,
    commonDir,
    linked,
    snapKey: `${shortHost()}/${worktreeId}`,
    git: new Git(worktree),
  };
}

export async function requireRepo(cwd = process.cwd()): Promise<RepoInfo> {
  const r = await findRepo(cwd);
  if (!r) throw new Error("not inside a git repository");
  return r;
}

export function expandHome(p: string): string {
  const home = process.env.HOME ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  return p;
}

/** Classify a destination root URL by transport. */
export function parseRoot(root: string): Dest {
  const raw = root.trim();

  if (raw.startsWith("ssh://")) {
    const rest = raw.slice("ssh://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return { kind: "other", url: raw };
    return { kind: "ssh", url: raw, host: rest.slice(0, slash), path: rest.slice(slash) };
  }

  // git://, https://, file:// and friends - we can address them but not create them.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { kind: "other", url: raw };

  // scp-like [user@]host:path, where the colon precedes any slash.
  const colon = raw.indexOf(":");
  const slash = raw.indexOf("/");
  if (colon > 0 && (slash === -1 || colon < slash)) {
    return { kind: "ssh", url: raw, host: raw.slice(0, colon), path: raw.slice(colon + 1) };
  }

  const path = resolve(expandHome(raw));
  return { kind: "local", url: path, path };
}

/**
 * Compute the destination for a repo.
 *
 * Repos under `base` map to their relative path, so ~/Dev/_fork/x becomes
 * <root>/_fork/x.git. Repos outside `base` map to their absolute path with the
 * leading slash dropped (/opt/src/thing -> <root>/opt/src/thing.git), which keeps
 * the mapping collision-free rather than flattening to a basename.
 *
 * Both sides go through realpath first. git reports fully resolved paths, while
 * `backup.base` is whatever the user typed - and on macOS /tmp and /var are
 * symlinks, as is many a ~/Dev. Comparing unresolved against resolved silently
 * pushes every repo into the outside-base branch and buries the whole tree under
 * a duplicated absolute path at the destination.
 */
export function destFor(rootUrl: string, base: string, repoRoot: string): Dest {
  const dest = parseRoot(rootUrl);
  const real = (p: string) => {
    try {
      return realpathSync(resolve(expandHome(p)));
    } catch {
      return resolve(expandHome(p));
    }
  };
  const absBase = real(base);
  const absRepo = real(repoRoot);

  let rel: string;
  if (absRepo === absBase) rel = basename(absRepo);
  else if (absRepo.startsWith(`${absBase}/`)) rel = absRepo.slice(absBase.length + 1);
  else rel = absRepo.replace(/^\/+/, "");

  const suffix = `${rel}.git`;

  switch (dest.kind) {
    case "local":
      return { kind: "local", url: `${dest.path}/${suffix}`, path: `${dest.path}/${suffix}` };
    case "ssh": {
      const p = `${dest.path.replace(/\/+$/, "")}/${suffix}`;
      const url = dest.url.startsWith("ssh://") ? `ssh://${dest.host}${p}` : `${dest.host}:${p}`;
      return { kind: "ssh", url, host: dest.host, path: p };
    }
    case "other":
      return { kind: "other", url: `${dest.url.replace(/\/+$/, "")}/${suffix}` };
  }
}
