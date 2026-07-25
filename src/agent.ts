import { $ } from "bun";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_LABEL } from "./config.ts";

export type AgentPaths = { plist: string; log: string; label: string };

function xml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );
}

/**
 * Path of the running executable.
 *
 * `bun build --compile` makes process.execPath the compiled binary itself. When
 * running from source under `bun run`, execPath is bun and the plist would be
 * wrong, so that case is rejected rather than silently installing a broken agent.
 */
export function selfPath(): string {
  if (Bun.main.endsWith(".ts")) {
    throw new Error(
      "refusing to install an agent while running from source.\n" +
        "  Build first (bun run build) and install the compiled binary, or use the nix package.",
    );
  }
  return process.execPath;
}

export function agentPaths(label = DEFAULT_LABEL): AgentPaths {
  const home = process.env.HOME ?? "";
  return {
    label,
    plist: join(home, "Library", "LaunchAgents", `${label}.plist`),
    log: join(home, "Library", "Logs", "git-backup.log"),
  };
}

export function plistFor(
  label: string,
  exe: string,
  opts: { interval: number; log: string; startOnMount: boolean; path: string },
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(exe)}</string>
    <string>sweep</string>
  </array>
  <key>StartInterval</key><integer>${opts.interval}</integer>
  <key>StartOnMount</key><${opts.startOnMount ? "true" : "false"}/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${xml(opts.log)}</string>
  <key>StandardErrorPath</key><string>${xml(opts.log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(opts.path)}</string>
  </dict>
</dict>
</plist>
`;
}

/** PATH for the agent: wherever git actually lives, plus the system defaults. */
export function agentPath(): string {
  const git = Bun.which("git");
  const base = "/usr/bin:/bin:/usr/sbin:/sbin";
  return git ? `${dirname(git)}:${base}` : base;
}

export async function installAgent(opts: {
  label: string;
  interval: number;
  startOnMount: boolean;
}): Promise<AgentPaths> {
  const paths = agentPaths(opts.label);
  const exe = selfPath();

  await mkdir(dirname(paths.plist), { recursive: true });
  await mkdir(dirname(paths.log), { recursive: true });
  await Bun.write(
    paths.plist,
    plistFor(opts.label, exe, {
      interval: opts.interval,
      log: paths.log,
      startOnMount: opts.startOnMount,
      path: agentPath(),
    }),
  );

  const target = `gui/${process.getuid?.() ?? 501}`;
  // bootout first: bootstrap refuses when a service with this label already exists.
  await $`launchctl bootout ${target}/${opts.label}`.quiet().nothrow();
  const res = await $`launchctl bootstrap ${target} ${paths.plist}`.quiet().nothrow();
  if (res.exitCode !== 0) {
    throw new Error(`launchctl bootstrap failed: ${res.stderr.toString().trim()}`);
  }
  return paths;
}

export async function uninstallAgent(label: string): Promise<boolean> {
  const paths = agentPaths(label);
  await $`launchctl bootout gui/${process.getuid?.() ?? 501}/${label}`.quiet().nothrow();
  try {
    await unlink(paths.plist);
    return true;
  } catch {
    return false;
  }
}

export async function agentStatus(label: string): Promise<{ loaded: boolean; detail: string }> {
  const res = await $`launchctl print gui/${process.getuid?.() ?? 501}/${label}`.quiet().nothrow();
  return { loaded: res.exitCode === 0, detail: res.stdout.toString() };
}

/**
 * Fire-and-forget nudge from a git hook.
 *
 * Always resolves. A missing agent, a disabled agent or a launchctl failure must
 * never make a commit fail, so every outcome is success from the caller's view.
 */
export async function kickAgent(label: string): Promise<boolean> {
  const res = await $`launchctl kickstart gui/${process.getuid?.() ?? 501}/${label}`
    .quiet()
    .nothrow();
  return res.exitCode === 0;
}
