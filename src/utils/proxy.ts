import { execFileSync } from "node:child_process";

export interface ProxyConfig {
  enabled: boolean;
  url: string;
  container_name: string;
  container_runtime: "podman" | "docker" | null;
}

/**
 * Detect the first available container runtime (Podman preferred over Docker).
 */
export function detectContainerRuntime(): "podman" | "docker" | null {
  for (const cmd of ["podman", "docker"] as const) {
    try {
      execFileSync("which", [cmd], { stdio: "ignore" });
      return cmd;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Check whether the SafeClaw proxy is accepting connections on the given port.
 */
export function isProxyRunning(port: number = 8899): boolean {
  try {
    execFileSync(
      "curl",
      ["-sf", `http://localhost:${port}/aep/api/state`],
      { stdio: "ignore", timeout: 2000 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull and start the SafeClaw proxy container.
 * Forwards OPENAI_API_KEY and ANTHROPIC_API_KEY from the current environment.
 * Returns true if the proxy is reachable within ~15 seconds.
 */
export function startProxy(
  runtime: "podman" | "docker",
  port: number = 8899
): boolean {
  const image = "ghcr.io/aceteam-ai/aep-proxy:latest";
  const name = "safeclaw-proxy";

  try {
    // Remove any existing stopped container with the same name
    try {
      execFileSync(runtime, ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      // Container may not exist — fine
    }

    const args = ["run", "-d", "--name", name, "-p", `${port}:${port}`];
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      const value = process.env[key];
      if (value) {
        args.push("-e", `${key}=${value}`);
      }
    }
    args.push(image);

    execFileSync(runtime, args, { stdio: "pipe" });

    // Poll until proxy is ready (up to ~15 s)
    for (let i = 0; i < 30; i++) {
      if (isProxyRunning(port)) return true;
      execFileSync("sleep", ["0.5"], { stdio: "ignore" });
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Stop and remove the SafeClaw proxy container.
 */
export function stopProxy(runtime: "podman" | "docker"): void {
  try {
    execFileSync(runtime, ["stop", "safeclaw-proxy"], { stdio: "ignore" });
    execFileSync(runtime, ["rm", "safeclaw-proxy"], { stdio: "ignore" });
  } catch {
    // Container may not exist — that's fine
  }
}
