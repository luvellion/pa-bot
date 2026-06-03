/**
 * Version checker - compares local commit hash against GitHub's latest.
 * Notifies at startup if the bot is behind.
 * Also provides periodic update checks and semver display.
 *
 * @module util/version-check
 */

// Read version from deno.json at startup
const denoConfig = JSON.parse(Deno.readTextFileSync("deno.json"));

/** Current bot version from deno.json */
export const BOT_VERSION: string = denoConfig.version ?? "unknown";

const REPO_OWNER = "luvellion";
const REPO_NAME = "pa-bot";

// The upstream-style "you're behind the repo HEAD" nag is off by default: this
// fork deploys via CI + GitOps (push to main → image build → rollout), not
// `docker compose pull`, so commit-diff update notices are just noise. Set
// VERSION_CHECK_ENABLED=true to re-enable.
const VERSION_CHECK_ENABLED = Deno.env.get("VERSION_CHECK_ENABLED") === "true";

export interface VersionCheckResult {
  upToDate: boolean;
  localCommit: string;
  remoteCommit: string;
  behind?: boolean;
  error?: string;
}

/**
 * Get the local HEAD commit hash using git.
 */
async function getLocalCommit(): Promise<string> {
  const cmd = new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error("Failed to get local git commit");
  }
  return new TextDecoder().decode(output.stdout).trim();
}

/**
 * Short build commit (git rev-parse --short HEAD) — we ship per-commit, not per
 * tag, so this identifies the running build. Falls back to "unknown".
 */
export async function getShortCommit(): Promise<string> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (output.success) return new TextDecoder().decode(output.stdout).trim();
  } catch { /* ignore — not a git checkout */ }
  return "unknown";
}

/**
 * Get the latest commit hash from GitHub API.
 */
async function getRemoteCommit(): Promise<string> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/main`;
  const response = await fetch(url, {
    headers: { "Accept": "application/vnd.github.v3+json" },
  });

  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }

  const data = await response.json();
  return data.sha;
}

/**
 * Check if the local version matches the latest on GitHub.
 */
export async function checkForUpdates(): Promise<VersionCheckResult> {
  try {
    const [localCommit, remoteCommit] = await Promise.all([
      getLocalCommit(),
      getRemoteCommit(),
    ]);

    const upToDate = localCommit === remoteCommit;

    return {
      upToDate,
      localCommit: localCommit.substring(0, 7),
      remoteCommit: remoteCommit.substring(0, 7),
      behind: !upToDate,
    };
  } catch (error) {
    return {
      upToDate: true, // Don't block startup on version check failure
      localCommit: "unknown",
      remoteCommit: "unknown",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Log a version check result at startup.
 * Returns an embed-friendly object if an update is available.
 */
export async function runVersionCheck(): Promise<{
  updateAvailable: boolean;
  embed?: {
    color: number;
    title: string;
    description: string;
    fields: Array<{ name: string; value: string; inline: boolean }>;
  };
}> {
  if (!VERSION_CHECK_ENABLED) return { updateAvailable: false };

  const result = await checkForUpdates();

  if (result.error) {
    console.log(`[Version Check] Could not check for updates: ${result.error}`);
    return { updateAvailable: false };
  }

  if (result.upToDate) {
    console.log(`[Version Check] Up to date (${result.localCommit})`);
    return { updateAvailable: false };
  }

  console.log(`[Version Check] Update available! Local: ${result.localCommit}, Latest: ${result.remoteCommit}`);

  return {
    updateAvailable: true,
    embed: {
      color: 0xFFA500, // Orange
      title: "Update Available",
      description: `The \`${REPO_OWNER}/${REPO_NAME}\` repo is ahead of the running build (**v${BOT_VERSION}**).`,
      fields: [
        { name: "Running Commit", value: `\`${result.localCommit}\``, inline: true },
        { name: "Latest Commit", value: `\`${result.remoteCommit}\``, inline: true },
        {
          name: "How to Update",
          value: "Merge to `main` → CI builds the image → `kubectl rollout restart deploy/pa-bot`.",
          inline: false
        },
      ],
    },
  };
}

/** Cached update check result for use in /status and periodic checks */
let lastCheckResult: VersionCheckResult | null = null;

/** Get cached update status (non-blocking, returns last known state) */
export function getLastCheckResult(): VersionCheckResult | null {
  return lastCheckResult;
}

/**
 * Start periodic update checks.
 * Runs checkForUpdates every `intervalMs` (default: 12 hours).
 * Calls `onUpdateAvailable` when an update is detected.
 */
export function startPeriodicUpdateCheck(
  onUpdateAvailable: (result: VersionCheckResult) => void,
  intervalMs = 12 * 60 * 60 * 1000
): ReturnType<typeof setInterval> | undefined {
  if (!VERSION_CHECK_ENABLED) return undefined;

  const check = async () => {
    try {
      const result = await checkForUpdates();
      lastCheckResult = result;
      if (result.behind) {
        onUpdateAvailable(result);
      }
    } catch {
      // Silently ignore periodic check failures
    }
  };

  // Run initial check to populate cache
  check();

  return setInterval(check, intervalMs);
}
