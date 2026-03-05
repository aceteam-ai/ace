import { loadConfig } from "./config.js";

export interface ProviderInfo {
  provider: "openai" | "anthropic" | "ollama" | "aceteam" | null;
  model?: string;
  detail?: string;
}

/**
 * Detect available LLM providers in priority order:
 * 1. AceTeam API key (fabric config)
 * 2. OpenAI API key (env var)
 * 3. Anthropic API key (env var)
 * 4. Ollama running locally
 */
export async function detectProvider(): Promise<ProviderInfo> {
  // AceTeam Fabric key
  const config = loadConfig();
  if (config.fabric_api_key && config.fabric_url) {
    return {
      provider: "aceteam",
      detail: config.fabric_url,
    };
  }

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      model: config.default_model || "gpt-4o-mini",
    };
  }

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    };
  }

  // Ollama — check if running locally
  const ollamaModel = await detectOllama();
  if (ollamaModel) {
    return {
      provider: "ollama",
      model: `ollama/${ollamaModel}`,
    };
  }

  return { provider: null };
}

async function detectOllama(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);

    const response = await fetch("http://localhost:11434/api/tags", {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };

    if (data.models && data.models.length > 0) {
      return data.models[0].name;
    }
  } catch {
    // Ollama not running
  }
  return null;
}

/**
 * Get a human-readable description of the detected provider.
 */
export function providerLabel(info: ProviderInfo): string {
  switch (info.provider) {
    case "aceteam":
      return `AceTeam Fabric (${info.detail})`;
    case "openai":
      return `OpenAI (${info.model})`;
    case "anthropic":
      return `Anthropic (${info.model})`;
    case "ollama":
      return `Ollama local (${info.model})`;
    default:
      return "No provider configured";
  }
}
