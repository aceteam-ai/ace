import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";

const CONFIG_DIR = join(homedir(), ".ace");
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

export interface AceConfig {
  default_model?: string;
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
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, YAML.stringify(config), "utf-8");
}
