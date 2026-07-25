import { $ } from "bun";
import { access, constants } from "node:fs/promises";
import type { Git } from "./git.ts";
import type { Config } from "./config.ts";
import type { Dest, RepoInfo } from "./repo.ts";

/** ssh probes must never hang a background sweep. */
const SSH_OPTS = "ssh -o ConnectTimeout=5 -o BatchMode=yes";

export type Reach = { ok: boolean; reason: string };

export async function reachable(repo: RepoInfo, cfg: Config, dest: Dest): Promise<Reach> {
  if (dest.kind === "local") {
    try {
      await access(dest.path, constants.W_OK);
    } catch {
      return { ok: false, reason: `destination not present or not writable: ${dest.path}` };
    }
  }

  const probe = await repo.git
    .run("ls-remote", "--quiet", cfg.remote);
  return probe.ok
    ? { ok: true, reason: "" }
    : { ok: false, reason: probe.stderr.trim().split("\n")[0] ?? "remote unreachable" };
}

/** One round trip: every ref the destination currently holds. */
export async function lsRemote(git: Git, remote: string): Promise<Map<string, string>> {
  const out = await git.lines("ls-remote", remote);
  const refs = new Map<string, string>();
  for (const line of out) {
    const [sha, ref] = line.split("\t");
    if (sha && ref) refs.set(ref, sha);
  }
  return refs;
}

export type AtticEntry = { branch: string; sha: string; why: "vanished" | "overwritten" };

/**
 * Preserve every remote branch tip that this push would destroy.
 *
 * Two cases: the local branch is gone (a prune would delete it), or the local
 * branch has moved somewhere that does not contain the remote tip (a rebase or
 * amend - the force push would orphan it). Both land in refs/backup/attic/ so
 * "I deleted the wrong branch" and "I rebased away good work" stay recoverable.
 */
export async function atticSweep(
  repo: RepoInfo,
  cfg: Config,
  remoteRefs: Map<string, string>,
): Promise<{ saved: AtticEntry[]; unsalvageable: string[] }> {
  const saved: AtticEntry[] = [];
  const unsalvageable: string[] = [];
  if (!cfg.attic) return { saved, unsalvageable };

  for (const [ref, sha] of remoteRefs) {
    if (!ref.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    const local = await repo.git.rev(`refs/heads/${branch}`);

    let why: AtticEntry["why"];
    if (local === null) why = "vanished";
    else if (!(await repo.git.isAncestor(sha, local))) why = "overwritten";
    else continue;

    // We can only name an object we hold. Normally we do - we pushed it.
    if (!(await repo.git.has(sha))) {
      unsalvageable.push(`${branch}@${sha.slice(0, 8)}`);
      continue;
    }

    const already = await repo.git.rev(`refs/backup/attic/${branch}/${sha.slice(0, 12)}`);
    if (already === sha) continue;

    await repo.git.run("update-ref", `refs/backup/attic/${branch}/${sha.slice(0, 12)}`, sha);
    saved.push({ branch, sha, why });
  }

  return { saved, unsalvageable };
}

export type PushOutcome = { ok: boolean; updated: string[]; error: string };

/**
 * Push branches, tags, snapshot buckets and attic refs.
 *
 * --no-verify follows git-auto-remote's own convention for sanctioned pushes
 * (src/lib/mirror-state.ts:201): a backup remote legitimately holds disjoint
 * histories, which gar's cross-history pre-push guard would otherwise reject.
 */
export async function pushAll(
  repo: RepoInfo,
  cfg: Config,
  opts: { prune?: boolean; dryRun?: boolean } = {},
): Promise<PushOutcome> {
  const args = ["push", "--no-verify", "--porcelain", "--atomic"];
  if (opts.dryRun) args.push("--dry-run");
  if (opts.prune) args.push("--prune");
  args.push(
    cfg.remote,
    "+refs/heads/*:refs/heads/*",
    "+refs/tags/*:refs/tags/*",
    "+refs/backup/*:refs/backup/*",
  );

  const res = await repo.git.run(...args);
  const updated = res.stdout
    .split("\n")
    .filter((l) => /^[*+\-=!]\t/.test(l) && !l.startsWith("=\t"))
    .map((l) => l.split("\t")[1] ?? l);

  return { ok: res.ok, updated, error: res.ok ? "" : res.stderr.trim() };
}

/** How many commits exist locally on branches that the destination has not got. */
export async function unpushedCount(repo: RepoInfo, remoteRefs: Map<string, string>): Promise<number> {
  const locals = await repo.git.lines("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  let total = 0;
  for (const line of locals) {
    const [ref, sha] = line.split(" ");
    if (!ref || !sha) continue;
    const remote = remoteRefs.get(ref);
    if (remote === sha) continue;
    const range = remote ? `${remote}..${sha}` : sha;
    const n = await repo.git.tryOut("rev-list", "--count", range);
    total += Number(n ?? "0") || 0;
  }
  return total;
}

export type AtticRef = { ref: string; committed: number };

export async function listAttic(git: Git): Promise<AtticRef[]> {
  const out = await git.lines(
    "for-each-ref",
    "--format=%(refname) %(committerdate:unix)",
    "refs/backup/attic/",
  );
  const refs: AtticRef[] = [];
  for (const line of out) {
    const [ref, ts] = line.split(" ");
    if (ref && ts) refs.push({ ref, committed: Number(ts) });
  }
  return refs;
}

/** Drop attic refs past their expiry, locally and on the destination. */
export async function gcAttic(
  repo: RepoInfo,
  cfg: Config,
  opts: { dryRun?: boolean } = {},
): Promise<{ expired: string[]; remoteDeleted: boolean }> {
  const cutoff = Math.floor(Date.now() / 1000) - cfg.atticExpire;
  const expired = (await listAttic(repo.git)).filter((r) => r.committed < cutoff).map((r) => r.ref);
  if (expired.length === 0 || opts.dryRun) return { expired, remoteDeleted: false };

  for (const ref of expired) await repo.git.run("update-ref", "-d", ref);

  const deletions = expired.map((r) => `:${r}`);
  const res = await repo.git.run("push", "--no-verify", cfg.remote, ...deletions);
  return { expired, remoteDeleted: res.ok };
}

/** Create the destination bare repo and tune it for network filesystems. */
export async function createDest(dest: Dest): Promise<void> {
  // receive.unpackLimit=1 forces every push to land as a single packfile. The
  // default (100) explodes small pushes into thousands of loose objects, which
  // is catastrophic over SMB/NFS/sshfs. gc.auto=0 keeps a push from ever
  // triggering a repack across the wire - and as a side effect the destination
  // retains rotated-out snapshots that the bucket refs no longer name.
  const tune = [
    ["receive.unpackLimit", "1"],
    ["transfer.unpackLimit", "1"],
    ["gc.auto", "0"],
    ["core.logAllRefUpdates", "true"],
  ] as const;

  if (dest.kind === "local") {
    await $`git init --bare --quiet ${dest.path}`.quiet();
    for (const [k, v] of tune) await $`git -C ${dest.path} config ${k} ${v}`.quiet().nothrow();
    return;
  }

  if (dest.kind === "ssh") {
    const cfg = tune.map(([k, v]) => `git -C '${dest.path}' config ${k} ${v}`).join(" && ");
    const script = `git init --bare --quiet '${dest.path}' && ${cfg}`;
    const res = await $`ssh ${dest.host} ${script}`.env({ ...process.env, GIT_SSH_COMMAND: SSH_OPTS }).quiet().nothrow();
    if (res.exitCode !== 0) throw new Error(`ssh init failed: ${res.stderr.toString().trim()}`);
    return;
  }

  throw new Error(
    `cannot create a destination over this transport: ${dest.url}\n` +
      "  Create the bare repo yourself, then run 'git backup init' again.",
  );
}
