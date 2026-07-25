import type { Git } from "./git.ts";

export const DEFAULT_WIP_INCLUDE = [
  "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs",
  "*.md", "*.mdx", "*.txt", "*.rst",
  "*.json", "*.jsonc", "*.toml", "*.yaml", "*.yml", "*.ini", "*.conf",
  "*.nix", "*.rs", "*.go", "*.py", "*.rb", "*.java", "*.kt", "*.swift",
  "*.c", "*.h", "*.cc", "*.cpp", "*.hpp", "*.zig",
  "*.sh", "*.bash", "*.fish", "*.zsh",
  "*.sql", "*.graphql", "*.proto",
  "*.css", "*.scss", "*.html", "*.svg", "*.vue", "*.svelte",
  "*.patch", "*.diff", "*.lock",
].join(" ");

export const DEFAULT_WIP_INCLUDE_NAME = [
  "Makefile", "Dockerfile", "Containerfile", "justfile", "Justfile",
  "Taskfile", "Rakefile", "Gemfile", "Procfile", "Brewfile",
  "LICENSE", "README", "CHANGELOG", "AGENTS", "CLAUDE",
  ".envrc", ".gitignore", ".gitattributes", ".editorconfig", ".dockerignore",
  "flake.lock",
].join(" ");

export const DEFAULT_BUCKETS = "latest hourly daily weekly";
export const DEFAULT_LABEL = "dev.gitbackup.sweep";

export type Config = {
  root: string | null;
  base: string;
  remote: string;
  buckets: string[];
  wipInclude: string[];
  wipIncludeName: string[];
  wipIncludeFile: string | null;
  wipMaxSize: number;
  attic: boolean;
  atticExpire: number;
  agentLabel: string;
  interval: number;
  enabled: boolean;
};

/** Parse "1m" / "512k" / "2g" / "1048576" into bytes. */
export function parseSize(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(raw.trim());
  if (!m) throw new Error(`invalid size: ${raw}`);
  const mult: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Math.floor(Number(m[1]) * (mult[(m[2] ?? "").toLowerCase()] ?? 1));
}

/** Parse "90d" / "12h" / "3w" / "3600" into seconds. */
export function parseDuration(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i.exec(raw.trim());
  if (!m) throw new Error(`invalid duration: ${raw}`);
  const mult: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return Math.floor(Number(m[1]) * (mult[(m[2] ?? "").toLowerCase()] ?? 1));
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["K", "M", "G", "T"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

export function humanAge(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function words(v: string | null, fallback: string): string[] {
  return (v ?? fallback).split(/\s+/).filter((s) => s.length > 0);
}

/** Git's boolean vocabulary: false/no/off/0 are false, everything else is true. */
function gitBool(v: string | null, fallback: boolean): boolean {
  return v === null ? fallback : !/^(false|no|off|0)$/i.test(v.trim());
}

export async function loadConfig(git: Git): Promise<Config> {
  const home = process.env.HOME ?? "";
  const get = (k: string) => git.config(`backup.${k}`);

  const [
    root, base, remote, buckets, wipInclude, wipIncludeName,
    wipIncludeFile, wipMaxSize, attic, atticExpire, agentLabel, interval, enabled,
  ] = await Promise.all([
    get("root"), get("base"), get("remote"), get("buckets"),
    get("wipInclude"), get("wipIncludeName"), get("wipIncludeFile"),
    get("wipMaxSize"), get("attic"), get("atticExpire"),
    get("agentLabel"), get("interval"), get("enabled"),
  ]);

  return {
    root: process.env.GIT_BACKUP_ROOT ?? root,
    base: process.env.GIT_BACKUP_BASE ?? base ?? `${home}/Dev`,
    remote: remote ?? "backup",
    buckets: words(buckets, DEFAULT_BUCKETS),
    wipInclude: words(wipInclude, DEFAULT_WIP_INCLUDE),
    wipIncludeName: words(wipIncludeName, DEFAULT_WIP_INCLUDE_NAME),
    wipIncludeFile,
    wipMaxSize: parseSize(wipMaxSize ?? "1m"),
    attic: gitBool(attic, true),
    atticExpire: parseDuration(atticExpire ?? "90d"),
    agentLabel: process.env.GIT_BACKUP_LABEL ?? agentLabel ?? DEFAULT_LABEL,
    interval: Number(interval ?? "300") || 300,
    enabled: gitBool(enabled, true),
  };
}
