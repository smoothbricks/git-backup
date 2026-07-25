import { $ } from "bun";
import { resolve } from "node:path";
import { globalConfigAll } from "./git.ts";
import { loadConfig } from "./config.ts";
import { createDest } from "./remote.ts";
import { destFor, findRepo, type RepoInfo } from "./repo.ts";
import { installHooks } from "./hooks.ts";

/**
 * The repo registry IS git maintenance's.
 *
 * `git maintenance register` appends to the global multi-valued maintenance.repo
 * key; we read the same list. One registration serves both tools, and a repo
 * already registered for maintenance starts being swept as soon as it grows a
 * backup remote.
 */
export async function registeredRepos(): Promise<string[]> {
  return globalConfigAll("maintenance.repo");
}

export async function registerPath(path: string): Promise<boolean> {
  const res = await $`git -C ${path} maintenance register`.quiet().nothrow();
  return res.exitCode === 0;
}

export async function unregisterPath(path: string): Promise<boolean> {
  const res = await $`git -C ${path} maintenance unregister --force`.quiet().nothrow();
  return res.exitCode === 0;
}

export type InitResult = {
  repo: RepoInfo;
  destUrl: string;
  created: boolean;
  remoteAdded: boolean;
  registered: boolean;
  hooks: string[];
};

export async function initRepo(
  repo: RepoInfo,
  opts: { root?: string; remote?: string; base?: string; hooks?: boolean; register?: boolean },
): Promise<InitResult> {
  const cfg = await loadConfig(repo.git);
  const root = opts.root ?? cfg.root;
  const remote = opts.remote ?? cfg.remote;
  const base = opts.base ?? cfg.base;

  if (!root) {
    throw new Error(
      "no destination configured.\n" +
        "  Set one globally:  git config --global backup.root /Volumes/Backup/Dev\n" +
        "  Or pass it here:   git backup init --root ssh://host/srv/backup",
    );
  }

  if (opts.root) await repo.git.run("config", "backup.root", opts.root);
  if (opts.base) await repo.git.run("config", "backup.base", opts.base);
  if (opts.remote) await repo.git.run("config", "backup.remote", opts.remote);

  const dest = destFor(root, base, repo.root);

  // Does the destination already exist? ls-remote against a URL needs no remote.
  const probe = await repo.git.run("ls-remote", "--quiet", dest.url);
  let created = false;
  if (!probe.ok) {
    await createDest(dest);
    created = true;
  }

  const existing = await repo.git.tryOut("remote", "get-url", remote);
  let remoteAdded = false;
  if (existing === null) {
    await repo.git.out("remote", "add", remote, dest.url);
    remoteAdded = true;
  } else if (existing !== dest.url) {
    await repo.git.out("remote", "set-url", remote, dest.url);
    remoteAdded = true;
  }

  const registered = opts.register === false ? false : await registerPath(repo.root);
  const hooks = opts.hooks === false ? [] : await installHooks(repo);

  return { repo, destUrl: dest.url, created, remoteAdded, registered, hooks };
}

export type RepoSummary = {
  path: string;
  present: boolean;
  hasRemote: boolean;
  enabled: boolean;
  destUrl: string | null;
  snapAge: number | null;
  unpushed: number | null;
  skipReason: string | null;
};

/** Cheap per-repo summary for `list`. Deliberately does no network work. */
export async function summarize(path: string): Promise<RepoSummary> {
  const base: RepoSummary = {
    path,
    present: false,
    hasRemote: false,
    enabled: true,
    destUrl: null,
    snapAge: null,
    unpushed: null,
    skipReason: null,
  };

  const repo = await findRepo(resolve(path));
  if (!repo) return { ...base, skipReason: "missing" };

  const cfg = await loadConfig(repo.git);
  const destUrl = await repo.git.tryOut("remote", "get-url", cfg.remote);
  const latest = await repo.git.tryOut(
    "for-each-ref",
    "--format=%(committerdate:unix)",
    `refs/backup/snap/${repo.snapKey}/latest`,
  );

  return {
    path,
    present: true,
    hasRemote: destUrl !== null,
    enabled: cfg.enabled,
    destUrl,
    snapAge: latest ? Math.floor(Date.now() / 1000) - Number(latest) : null,
    unpushed: null,
    skipReason: !cfg.enabled ? "disabled" : destUrl === null ? "no backup remote" : null,
  };
}
