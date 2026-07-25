import { $ } from "bun";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
};

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: RunResult,
  ) {
    super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "GitError";
  }
}

/**
 * Thin wrapper over `git -C <dir>`.
 *
 * Every call goes through Bun Shell with array interpolation, so arguments are
 * passed as a real argv - no shell word-splitting, no quoting hazards for paths
 * containing spaces.
 */
export class Git {
  constructor(
    readonly dir: string,
    private readonly extraEnv: Record<string, string> = {},
  ) {}

  async run(...args: string[]): Promise<RunResult> {
    const res = await $`git -C ${this.dir} ${args}`
      .env({ ...process.env, ...this.extraEnv } as Record<string, string>)
      .quiet()
      .nothrow();
    const code = res.exitCode;
    return {
      code,
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
      ok: code === 0,
    };
  }

  /** Run and throw on failure. Returns trimmed stdout. */
  async out(...args: string[]): Promise<string> {
    const r = await this.run(...args);
    if (!r.ok) throw new GitError(args, r);
    return r.stdout.trim();
  }

  /** Run and return trimmed stdout, or null on failure. */
  async tryOut(...args: string[]): Promise<string | null> {
    const r = await this.run(...args);
    return r.ok ? r.stdout.trim() : null;
  }

  /** Run and return only whether it succeeded. */
  async ok(...args: string[]): Promise<boolean> {
    return (await this.run(...args)).ok;
  }

  /** Run and split stdout on newlines, dropping empties. */
  async lines(...args: string[]): Promise<string[]> {
    const r = await this.run(...args);
    if (!r.ok) return [];
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }

  /** Run and split stdout on NUL, dropping empties. For `-z` output. */
  async nul(...args: string[]): Promise<string[]> {
    const r = await this.run(...args);
    if (!r.ok) return [];
    return r.stdout.split("\0").filter((l) => l.length > 0);
  }

  /** Read a single config value, or null when unset. Local overrides global. */
  async config(key: string): Promise<string | null> {
    return this.tryOut("config", "--get", key);
  }

  /** Does this object exist in the local object database? */
  async has(sha: string): Promise<boolean> {
    return this.ok("cat-file", "-e", `${sha}^{object}`);
  }

  /** Resolve a rev to a full SHA, or null when it does not resolve. */
  async rev(spec: string): Promise<string | null> {
    return this.tryOut("rev-parse", "-q", "--verify", spec);
  }

  /** Is `a` an ancestor of `b`? False when either is missing. */
  async isAncestor(a: string, b: string): Promise<boolean> {
    return this.ok("merge-base", "--is-ancestor", a, b);
  }
}

export async function globalConfigAll(key: string): Promise<string[]> {
  const res = await $`git config --global --get-all ${key}`.quiet().nothrow();
  if (res.exitCode !== 0) return [];
  return res.stdout
    .toString()
    .split("\n")
    .filter((l) => l.length > 0);
}

export async function setGlobalConfig(key: string, value: string): Promise<void> {
  await $`git config --global ${key} ${value}`.quiet().nothrow();
}

/** Remove one value from a multi-valued global key, leaving siblings intact. */
export async function unsetGlobalConfigValue(key: string, value: string): Promise<void> {
  const pattern = `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  await $`git config --global --unset-all ${key} ${pattern}`.quiet().nothrow();
}
