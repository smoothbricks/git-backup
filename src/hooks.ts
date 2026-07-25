import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { RepoInfo } from "./repo.ts";

/**
 * Hooks that mean "the refs moved, get a copy offsite".
 *
 * post-rewrite covers rebase and amend, which is exactly when the attic earns
 * its keep.
 */
export const HOOKS = ["post-commit", "post-rewrite", "post-checkout", "post-merge"] as const;
export type HookName = (typeof HOOKS)[number];

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

function withBlock(existing: string | null, hook: string): string {
  const body = block(hook);
  if (existing === null || existing.trim() === "") {
    return `#!/bin/sh\n${body}\n`;
  }
  const open = OPEN(hook);
  const close = CLOSE(hook);
  const start = existing.indexOf(open);
  if (start === -1) {
    const sep = existing.endsWith("\n") ? "" : "\n";
    return `${existing}${sep}${body}\n`;
  }
  const end = existing.indexOf(close, start);
  if (end === -1) return `${existing.slice(0, start)}${body}\n`;
  return `${existing.slice(0, start)}${body}${existing.slice(end + close.length)}`;
}

async function hooksDir(repo: RepoInfo): Promise<string> {
  // Respects core.hooksPath, which some repos redirect.
  const p = await repo.git.tryOut("rev-parse", "--path-format=absolute", "--git-path", "hooks");
  return p ?? join(repo.commonDir, "hooks");
}

export async function installHooks(repo: RepoInfo): Promise<HookName[]> {
  const dir = await hooksDir(repo);
  const done: HookName[] = [];

  for (const hook of HOOKS) {
    const path = join(dir, hook);
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : null;
    await Bun.write(path, withBlock(existing, hook));
    await chmod(path, 0o755);
    done.push(hook);
  }

  return done;
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
    const cut = end === -1 ? text.slice(0, start) : text.slice(0, start) + text.slice(end + CLOSE(hook).length);

    // A file that is now nothing but a shebang was ours alone; drop the body.
    await Bun.write(path, cut.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
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
