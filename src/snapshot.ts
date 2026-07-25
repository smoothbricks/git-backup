import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { Git } from "./git.ts";
import { humanSize, type Config } from "./config.ts";
import type { RepoInfo } from "./repo.ts";
import { snapRef } from "./buckets.ts";

export type Skip = { path: string; reason: string };

export type SnapResult =
  | { kind: "clean" }
  | { kind: "unchanged"; tree: string }
  | { kind: "created"; commit: string; tree: string; included: string[]; skipped: Skip[] };

const ADD_CHUNK = 400;
const SNIFF_BYTES = 8192;

async function readIncludeFile(repo: RepoInfo, rel: string): Promise<string[]> {
  const f = Bun.file(join(repo.worktree, rel));
  if (!(await f.exists())) return [];
  return (await f.text())
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l.length > 0);
}

/**
 * Three gates, cheapest first, all fork-free:
 *   1. name or glob allowlist  2. size cap  3. binary sniff
 *
 * Allowlisting - rather than trusting .gitignore - is the whole point: a build
 * artifact or model checkpoint must not reach the backup in the window before
 * .gitignore catches up with it. Gates 2 and 3 exist because an allowlisted
 * extension is not a guarantee: a *.json can be a 2GB API dump, and a
 * name-allowlisted extensionless file can be a compiled binary.
 */
async function gate(
  repo: RepoInfo,
  cfg: Config,
  candidates: string[],
  allFiles: boolean,
): Promise<{ keep: string[]; skipped: Skip[] }> {
  if (allFiles) return { keep: candidates, skipped: [] };

  const extra = cfg.wipIncludeFile ? await readIncludeFile(repo, cfg.wipIncludeFile) : [];
  const isPattern = (p: string) => /[*?[\]{}]/.test(p);
  const globs = [...cfg.wipInclude, ...extra.filter(isPattern)].map((p) => new Bun.Glob(p));
  const names = new Set([...cfg.wipIncludeName, ...extra.filter((p) => !isPattern(p))]);

  const keep: string[] = [];
  const skipped: Skip[] = [];

  for (const rel of candidates) {
    const name = rel.slice(rel.lastIndexOf("/") + 1);

    if (!names.has(name) && !globs.some((g) => g.match(name))) {
      skipped.push({ path: rel, reason: "no rule" });
      continue;
    }

    const file = Bun.file(join(repo.worktree, rel));
    let size: number;
    try {
      size = (await file.stat()).size;
    } catch {
      skipped.push({ path: rel, reason: "unreadable" });
      continue;
    }

    if (size > cfg.wipMaxSize) {
      skipped.push({ path: rel, reason: humanSize(size) });
      continue;
    }

    if (size > 0) {
      try {
        const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
        if (head.includes(0)) {
          skipped.push({ path: rel, reason: "binary" });
          continue;
        }
      } catch {
        skipped.push({ path: rel, reason: "unreadable" });
        continue;
      }
    }

    keep.push(rel);
  }

  return { keep, skipped };
}

/**
 * Build a snapshot commit from the current worktree.
 *
 * Never touches HEAD, the real index, the worktree, or the stash: everything is
 * staged into a throwaway GIT_INDEX_FILE and written out with write-tree +
 * commit-tree.
 */
export async function snapshot(
  repo: RepoInfo,
  cfg: Config,
  opts: { allFiles?: boolean } = {},
): Promise<SnapResult> {
  const idx = join(tmpdir(), `git-backup-index-${process.pid}-${Date.now()}`);
  const staged = new Git(repo.worktree, { GIT_INDEX_FILE: idx });
  const head = await repo.git.rev("HEAD");

  try {
    if (head) await staged.run("read-tree", head);

    // Tracked modifications and deletions: always, unconditionally. Those files
    // were vetted when they were first added and are already in history.
    await staged.run("add", "-u");

    const candidates = await staged.nul("ls-files", "--others", "--exclude-standard", "-z");
    const { keep, skipped } = await gate(repo, cfg, candidates, opts.allFiles ?? false);

    for (let i = 0; i < keep.length; i += ADD_CHUNK) {
      await staged.run("add", "--", ...keep.slice(i, i + ADD_CHUNK));
    }

    const tree = await staged.out("write-tree");

    // Nothing uncommitted: a snapshot equal to HEAD carries no information.
    if (head && tree === (await repo.git.rev(`${head}^{tree}`))) return { kind: "clean" };

    // Nothing new since the last snapshot. Guarding on the TREE rather than the
    // commit is what stops an idle repo minting a fresh timestamped commit every
    // sweep and slowly filling the destination with identical content.
    const prev = await repo.git.rev(`${snapRef(repo.snapKey, "latest")}^{tree}`);
    if (tree === prev) return { kind: "unchanged", tree };

    const branch = (await repo.git.tryOut("branch", "--show-current")) || "detached";
    const when = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const lines = [
      `wip ${when} on ${branch}`,
      "",
      `${keep.length} untracked file${keep.length === 1 ? "" : "s"} included, ${skipped.length} skipped`,
    ];
    if (skipped.length > 0) {
      // Every exclusion is reported. A backup that silently under-covers is
      // worse than no backup, so the omissions live in the commit message.
      lines.push("");
      for (const s of skipped) lines.push(`skipped: ${s.path} (${s.reason})`);
    }

    const args = ["commit-tree", tree, "-m", lines.join("\n")];
    if (head) args.push("-p", head);

    return {
      kind: "created",
      commit: await repo.git.out(...args),
      tree,
      included: keep,
      skipped,
    };
  } finally {
    await unlink(idx).catch(() => {});
  }
}
