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
  sourceEnv: string;
}

/** Inspect the live proxy before interpreting base URLs in the agent shell. */
export function inspectProxyForInit(
  env: NodeJS.ProcessEnv = process.env,
  port: number = 8899,
  probes: {
    isRunning: (port: number) => boolean;
    resolve: (env: NodeJS.ProcessEnv, port: number) => ProxyUpstream | null;
  } = { isRunning: isProxyRunning, resolve: resolveProxyUpstream }
): {
  alreadyRunning: boolean;
  upstream: ProxyUpstream | null;
  warning: string | null;
  error: string | null;
} {
  if (probes.isRunning(port)) {
    return { alreadyRunning: true, upstream: null, warning: null, error: null };
  }
  try {
    return {
      alreadyRunning: false,
      upstream: probes.resolve(env, port),
      warning: null,
      error: null,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const explicit = Boolean(
      env.UPSTREAM_OPENAI_BASE_URL?.trim() || env.UPSTREAM_ANTHROPIC_BASE_URL?.trim()
    );
    return {
      alreadyRunning: false,
      upstream: null,
      warning: explicit ? null : `Ignoring agent base URL for proxy target: ${message}`,
      error: explicit ? message : null,
    };
  }
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

  const host = url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^::ffff:(?:0:)?(?:127\.|7f[0-9a-f]{2}:)/.test(host);
  if (loopback) {
    throw new Error("Proxy upstream uses a loopback address unreachable from the container");
  }

  const localHosts = new Set([
    "aep-proxy",
    "safeclaw-proxy",
    "host.docker.internal",
    "host.containers.internal",
  ]);
  const upstreamPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (localHosts.has(host) && upstreamPort === port) {
    throw new Error("Proxy upstream points back to the local proxy");
  }

  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
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
  return { target: normalizeUpstreamUrl(env[key]!, port), provider, sourceEnv: key };
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
  for (const route of ["dashboard", "aep"]) {
    try {
      execFileSync(
        "curl",
        ["-sf", `http://localhost:${port}/${route}/api/state`],
        { stdio: "ignore", timeout: 2000 }
      );
      return true;
    } catch {
      // Older cached images expose /aep; try the other route.
    }
  }
  return false;
}

/**
 * Pull and start the SafeClaw proxy container.
 * Forwards the selected upstream. Provider keys for a custom upstream require
 * ACE_PROXY_FORWARD_PROVIDER_KEY=1; otherwise the client's auth is preserved.
 * Returns true if the proxy is reachable within ~15 seconds.
 */
export function startProxy(
  runtime: "podman" | "docker",
  port: number = 8899,
  upstream?: ProxyUpstream | null
): boolean {
  const image = "ghcr.io/aceteam-ai/aep-proxy:latest";
  const name = "safeclaw-proxy";

  try {
    const selected = upstream === undefined ? resolveProxyUpstream(process.env, port) : upstream;
    // Remove any existing stopped container with the same name
    try {
      execFileSync(runtime, ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      // Container may not exist — fine
    }

    const args = ["run", "-d", "--name", name, "-p", `${port}:${port}`];
    let childEnv: NodeJS.ProcessEnv | undefined;
    if (selected) {
      const host = new URL(selected.target).hostname.toLowerCase().replace(/\.+$/, "");
      if (runtime === "docker" && process.platform === "linux" && host === "host.docker.internal") {
        args.push("--add-host=host.docker.internal:host-gateway");
      }
      const officialHost = selected.provider === "openai" ? "api.openai.com" : "api.anthropic.com";
      const standardOfficial =
        selected.sourceEnv === `${selected.provider.toUpperCase()}_BASE_URL` && host === officialHost;
      if (process.env.ACE_PROXY_FORWARD_PROVIDER_KEY === "1" || standardOfficial) {
        const sourceKey = `${selected.provider.toUpperCase()}_API_KEY`;
        if (process.env[sourceKey]) {
          // The current image chooses its startup key by a URL substring. For
          // custom Anthropic hosts without that substring, provide the chosen
          // key under the name it reads. /v1/messages still uses x-api-key.
          const imageKey =
            selected.provider === "anthropic" &&
            !selected.target.toLowerCase().includes("anthropic")
              ? "OPENAI_API_KEY"
              : sourceKey;
          childEnv = {
            ...process.env,
            [imageKey]: process.env[sourceKey],
            AEP_TARGET_API_KEY: process.env[sourceKey],
          };
          // Docker/Podman copy the value from the child environment. It does
          // not appear in process arguments.
          args.push("-e", imageKey, "-e", "AEP_TARGET_API_KEY");
        }
      }
    } else {
      for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
        if (process.env[key]) args.push("-e", key);
      }
    }
    args.push(image);
    if (selected) {
      // The image's entrypoint is aceteam-aep. Supplying arguments replaces
      // its default CMD, so repeat the port and bind address here.
      args.push(
        "proxy", "--port", String(port), "--host", "0.0.0.0",
        "--target", selected.target
      );
    }

    execFileSync(runtime, args, { stdio: "pipe", ...(childEnv ? { env: childEnv } : {}) });

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
