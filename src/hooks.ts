import { chmod, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { RepoInfo } from "./repo.ts";

/**
 * Hooks that mean "the refs moved, get a copy offsite".
 *
 * post-rewrite covers rebase and amend, which is exactly when the attic earns
 * its keep.
 */
export const HOOKS = ["post-commit", "post-rewrite", "post-checkout", "post-merge"] as const;
export type HookName = (typeof HOOKS)[number];

export type InstallResult = { hooks: HookName[]; excluded: boolean };

/**
 * Same chainable sentinel shape git-auto-remote uses, so both tools can own a
 * block in one hook file and each can detect the other by grepping.
 */
const OPEN = (h: string) => `# >>> git-backup ${h} >>>`;
const CLOSE = (h: string) => `# <<< git-backup ${h} <<<`;

function block(hook: string): string {
  return [
    OPEN(hook),
    "# Nudge the launchd agent; never block or fail the git operation.",
    "command -v git-backup >/dev/null 2>&1 && git-backup agent kick >/dev/null 2>&1 || true",
    CLOSE(hook),
  ].join("\n");
}

/** Idempotent: replaces our block in place, or appends it, never duplicating. */
function withBlock(existing: string | null, hook: string): string {
  const body = block(hook);
  if (existing === null || existing.trim() === "") return `#!/bin/sh\n${body}\n`;

  const start = existing.indexOf(OPEN(hook));
  if (start === -1) {
    return `${existing}${existing.endsWith("\n") ? "" : "\n"}${body}\n`;
  }
  const end = existing.indexOf(CLOSE(hook), start);
  if (end === -1) return `${existing.slice(0, start)}${body}\n`;
  return `${existing.slice(0, start)}${body}${existing.slice(end + CLOSE(hook).length)}`;
}

async function hooksDir(repo: RepoInfo): Promise<string> {
  // Respects core.hooksPath, which git honours to the exclusion of .git/hooks.
  const p = await repo.git.tryOut("rev-parse", "--path-format=absolute", "--git-path", "hooks");
  return p ?? join(repo.commonDir, "hooks");
}

/**
 * A repo that points `core.hooksPath` at something like `.githooks` keeps its
 * hooks IN the worktree, usually tracked so the team shares them. Our hook is
 * machine-local, so writing files there leaves the repo permanently dirty with
 * untracked entries that could be committed by accident. Record them in
 * .git/info/exclude - local-only, never shared - so the hook still fires and
 * `git status` stays clean.
 */
async function excludeLocally(repo: RepoInfo, dir: string, names: readonly string[]): Promise<boolean> {
  if (!dir.startsWith(`${repo.worktree}/`)) return false;

  const wanted = names.map((n) => `/${relative(repo.worktree, join(dir, n))}`);
  const path = join(repo.commonDir, "info", "exclude");
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";
  const missing = wanted.filter((line) => !existing.split("\n").includes(line));
  if (missing.length === 0) return true;

  const body = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(
    path,
    `${body}# git-backup: machine-local hooks inside a tracked hooks directory\n${missing.join("\n")}\n`,
  );
  return true;
}

export async function installHooks(repo: RepoInfo): Promise<InstallResult> {
  const dir = await hooksDir(repo);
  const done: HookName[] = [];

  for (const hook of HOOKS) {
    const path = join(dir, hook);
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : null;
    await mkdir(dir, { recursive: true });
    await Bun.write(path, withBlock(existing, hook));
    await chmod(path, 0o755);
    done.push(hook);
  }

  return { hooks: done, excluded: await excludeLocally(repo, dir, done) };
}

export async function uninstallHooks(repo: RepoInfo): Promise<HookName[]> {
  const dir = await hooksDir(repo);
  const done: HookName[] = [];

  for (const hook of HOOKS) {
    const path = join(dir, hook);
    const file = Bun.file(path);
    if (!(await file.exists())) continue;

    const text = await file.text();
    const start = text.indexOf(OPEN(hook));
    if (start === -1) continue;
    const end = text.indexOf(CLOSE(hook), start);
    const cut =
      end === -1 ? text.slice(0, start) : text.slice(0, start) + text.slice(end + CLOSE(hook).length);

    await Bun.write(path, `${cut.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`);
    done.push(hook);
  }

  return done;
}

export async function hooksInstalled(repo: RepoInfo): Promise<HookName[]> {
  const dir = await hooksDir(repo);
  const found: HookName[] = [];
  for (const hook of HOOKS) {
    const file = Bun.file(join(dir, hook));
    if (!(await file.exists())) continue;
    if ((await file.text()).includes(OPEN(hook))) found.push(hook);
  }
  return found;
}
