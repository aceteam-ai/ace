import { execFileSync } from "node:child_process";

export interface ProxyConfig {
  enabled: boolean;
  url: string;
  container_name: string;
  container_runtime: "podman" | "docker" | null;
}

export interface ProxyUpstream {
  target: string;
  provider: "openai" | "anthropic";
}

/**
 * The proxy app appends request paths such as /v1/chat/completions to its
 * target, while model clients normally include /v1 in their base URL.
 */
function normalizeUpstreamUrl(value: string, port: number): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Proxy upstream must be an HTTP or HTTPS base URL");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Proxy upstream must be an HTTP or HTTPS URL without credentials, query, or fragment"
    );
  }

  const localHosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "aep-proxy",
    "safeclaw-proxy",
    "host.docker.internal",
    "host.containers.internal",
  ]);
  const upstreamPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (localHosts.has(url.hostname.toLowerCase()) && upstreamPort === port) {
    throw new Error("Proxy upstream points back to the local proxy");
  }

  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${path}`;
}

/** Resolve one upstream from the host environment. The image has one target. */
export function resolveProxyUpstream(
  env: NodeJS.ProcessEnv = process.env,
  port: number = 8899
): ProxyUpstream | null {
  const explicit = [
    ["UPSTREAM_OPENAI_BASE_URL", "openai"],
    ["UPSTREAM_ANTHROPIC_BASE_URL", "anthropic"],
  ] as const;
  const standard = [
    ["OPENAI_BASE_URL", "openai"],
    ["ANTHROPIC_BASE_URL", "anthropic"],
  ] as const;
  const configured = explicit.filter(([key]) => env[key]?.trim());
  const candidates = configured.length
    ? configured
    : standard.filter(([key]) => env[key]?.trim());

  if (candidates.length > 1) {
    throw new Error(
      "The proxy supports one upstream at a time; set only one upstream base URL"
    );
  }
  if (!candidates.length) return null;

  const [key, provider] = candidates[0];
  return { target: normalizeUpstreamUrl(env[key]!, port), provider };
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
      ["-sf", `http://localhost:${port}/dashboard/api/state`],
      { stdio: "ignore", timeout: 2000 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull and start the SafeClaw proxy container.
 * Forwards the selected upstream and its API key from the current environment.
 * Returns true if the proxy is reachable within ~15 seconds.
 */
export function startProxy(
  runtime: "podman" | "docker",
  port: number = 8899,
  upstream: ProxyUpstream | null = resolveProxyUpstream(process.env, port)
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
      if (
        process.env[key] &&
        (!upstream || key === `${upstream.provider.toUpperCase()}_API_KEY`)
      ) {
        // Docker and Podman copy the variable from the host environment.
        // Its value must not appear in process arguments.
        args.push("-e", key);
      }
    }
    args.push(image);
    if (upstream) {
      // The image's entrypoint is aceteam-aep. Supplying arguments replaces
      // its default CMD, so repeat the port and bind address here.
      args.push(
        "proxy", "--port", String(port), "--host", "0.0.0.0",
        "--target", upstream.target
      );
    }

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
