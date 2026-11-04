import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_CREDENTIAL_BYTES = 16 * 1024;

export interface PlatformCredentials {
  origin: string;
  apiKey: string;
}

export interface PlatformCredentialOptions {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
}

export function getPlatformCredentialsPath(): string {
  return join(homedir(), ".ace", "platform", "credentials.json");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizePlatformOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Platform URL must be an HTTPS origin.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("Platform URL must contain only an origin, without credentials, path, query, or fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("Platform URL must use HTTPS. HTTP is allowed only for an explicit loopback origin.");
  }
  return url.origin;
}

function checkedCredentials(value: unknown): PlatformCredentials {
  if (!value || typeof value !== "object") throw new Error("Platform credentials are invalid.");
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== 2 || !keys.includes("origin") || !keys.includes("apiKey")) {
    throw new Error("Platform credentials must contain only a URL and API key.");
  }
  if (typeof candidate.origin !== "string" || candidate.origin.length > 2048 || typeof candidate.apiKey !== "string" || !candidate.apiKey.trim() || candidate.apiKey.length > 8192) {
    throw new Error("Platform credentials must contain a URL and API key.");
  }
  const credentials = { origin: normalizePlatformOrigin(candidate.origin), apiKey: candidate.apiKey.trim() };
  if (Buffer.byteLength(`${JSON.stringify(credentials)}\n`, "utf8") > MAX_CREDENTIAL_BYTES) {
    throw new Error("Platform credentials are too large.");
  }
  return credentials;
}

function assertPrivateFile(stat: Awaited<ReturnType<typeof lstat>>): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Platform credentials must be a regular file.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Platform credentials must be owned by the current user.");
  }
  if ((Number(stat.mode) & 0o077) !== 0) throw new Error("Platform credentials permissions must be 0600.");
  if (stat.size > MAX_CREDENTIAL_BYTES) throw new Error("Platform credentials file is too large.");
}

export async function readPlatformCredentials(credentialsPath = getPlatformCredentialsPath()): Promise<PlatformCredentials | undefined> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(credentialsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  assertPrivateFile(before);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(credentialsPath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  try {
    const current = await handle.stat();
    assertPrivateFile(current);
    if (before.dev !== current.dev || before.ino !== current.ino) {
      throw new Error("Platform credentials changed while being opened.");
    }
    const buffer = Buffer.alloc(current.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CREDENTIAL_BYTES) throw new Error("Platform credentials file is too large.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw new Error("Platform credentials contain invalid JSON.");
    }
    return checkedCredentials(parsed);
  } finally {
    await handle.close();
  }
}

export async function resolvePlatformCredentials(options: PlatformCredentialOptions = {}): Promise<PlatformCredentials> {
  const env = options.env ?? process.env;
  const origin = env.ACETEAM_PLATFORM_URL;
  const apiKey = env.ACETEAM_PLATFORM_API_KEY;
  if (origin || apiKey) {
    if (!origin || !apiKey) throw new Error("ACETEAM_PLATFORM_URL and ACETEAM_PLATFORM_API_KEY must be set together.");
    return checkedCredentials({ origin, apiKey });
  }
  const stored = await readPlatformCredentials(options.credentialsPath);
  if (!stored) throw new Error("Platform credentials not found. Run: ace templates login --url <https-origin>");
  return stored;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Platform credential directory must be a regular directory.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Platform credential directory must be owned by the current user.");
  }
  if ((Number(stat.mode) & 0o077) !== 0) throw new Error("Platform credential directory permissions must be 0700.");
}

export async function savePlatformCredentials(credentials: PlatformCredentials, credentialsPath = getPlatformCredentialsPath()): Promise<void> {
  const checked = checkedCredentials(credentials);
  const directory = dirname(credentialsPath);
  await ensurePrivateDirectory(directory);
  try {
    const existing = await lstat(credentialsPath);
    assertPrivateFile(existing);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.credentials-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(checked)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, credentialsPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removePlatformCredentials(credentialsPath = getPlatformCredentialsPath()): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(credentialsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  assertPrivateFile(stat);
  await rm(credentialsPath);
  return true;
}
