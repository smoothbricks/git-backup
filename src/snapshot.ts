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

/**
 * Per-exec argv budget. macOS ARG_MAX is 1 MiB and the environment counts
 * against it, so stay well clear.
 */
const ARG_BUDGET = 96 * 1024;
const SNIFF_BYTES = 8192;
const SKIP_EXAMPLES = 12;

function* byArgBudget(paths: readonly string[]): Generator<string[]> {
  let batch: string[] = [];
  let bytes = 0;
  for (const p of paths) {
    const cost = Buffer.byteLength(p) + 1;
    if (batch.length > 0 && bytes + cost > ARG_BUDGET) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(p);
    bytes += cost;
  }
  if (batch.length > 0) yield batch;
}

/**
 * Exclusions must stay visible - a backup that silently under-covers is worse
 * than no backup - but one build directory yields tens of thousands of them.
 * Aggregate by reason and by top-level directory, then show a few examples.
 * That is both bounded and more useful than an unreadable wall of paths.
 */
function summariseSkips(skipped: readonly Skip[]): string[] {
  if (skipped.length === 0) return [];

  const byReason = new Map<string, number>();
  const byDir = new Map<string, number>();
  for (const s of skipped) {
    // Size reasons are per-file ("4.2M"); collapse them into one bucket.
    const reason = /^\d/.test(s.reason) ? "too large" : s.reason;
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    const slash = s.path.indexOf("/");
    const dir = slash === -1 ? "(root)" : `${s.path.slice(0, slash)}/`;
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }

  const rank = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ");

  const out = ["", `skipped by reason: ${rank(byReason, 6)}`, `top directories:   ${rank(byDir, 6)}`, ""];
  for (const s of skipped.slice(0, SKIP_EXAMPLES)) out.push(`  ${s.path} (${s.reason})`);
  if (skipped.length > SKIP_EXAMPLES) out.push(`  ... and ${skipped.length - SKIP_EXAMPLES} more`);
  return out;
}

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

    // Chunk by BYTES, not by count. A Rust target/ tree has paths hundreds of
    // characters long, so a fixed count of 400 can still exceed ARG_MAX.
    for (const chunk of byArgBudget(keep)) {
      await staged.run("add", "--", ...chunk);
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
    const message = [
      `wip ${when} on ${branch}`,
      "",
      `${keep.length} untracked file${keep.length === 1 ? "" : "s"} included, ${skipped.length} skipped`,
      ...summariseSkips(skipped),
    ].join("\n");

    // Message goes in on STDIN. commit-tree reads it from there when no -m is
    // given, which is the only way it cannot blow ARG_MAX - a build directory
    // yields tens of thousands of exclusions and -m made the argv megabytes.
    const args = ["commit-tree", tree];
    if (head) args.push("-p", head);
    const made = await repo.git.runInput(message, ...args);
    if (!made.ok) throw new Error(`commit-tree failed: ${made.stderr.trim()}`);

    return {
      kind: "created",
      commit: made.stdout.trim(),
      tree,
      included: keep,
      skipped,
    };
  } finally {
    await unlink(idx).catch(() => {});
  }
}
