import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";

const CONFIG_DIR = process.env.ACE_CONFIG_DIR || join(homedir(), ".ace");
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

export interface AceConfig {
  default_model?: string;
  fabric_url?: string;
  fabric_api_key?: string;
  python_path?: string;
  venv_dir?: string;
  patterns_dir?: string;
  api_keys?: { openai?: string; anthropic?: string };
  user_email?: string;
  proxy_enabled?: boolean;
  proxy_url?: string;
  proxy_container?: string;
  control_plane?: ControlPlaneSession;
}

export interface ControlPlaneSession {
  kind: "oauth" | "api_key";
  mcp_url: string;
  access_token: string;
  refresh_token?: string;
  client_id?: string;
  expires_at?: number;
  active_org_id?: string;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): AceConfig {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }
  const content = readFileSync(CONFIG_PATH, "utf-8");
  return (YAML.parse(content) as AceConfig) || {};
}

export function saveConfig(config: AceConfig): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_PATH, YAML.stringify(config), {
    encoding: "utf-8",
    mode: 0o600,
  });
  chmodSync(CONFIG_PATH, 0o600);
}
