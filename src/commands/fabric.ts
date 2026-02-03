import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, saveConfig } from "../utils/config.js";
import { FabricClient } from "../utils/fabric.js";
import * as output from "../utils/output.js";

function requireFabricConfig(): { url: string; apiKey: string } {
  const config = loadConfig();
  if (!config.fabric_url || !config.fabric_api_key) {
    output.error(
      "Fabric not configured. Run: ace fabric login"
    );
    process.exit(1);
  }
  return { url: config.fabric_url, apiKey: config.fabric_api_key };
}

export const fabricCommand = new Command("fabric").description(
  "Manage Sovereign Compute Fabric connections"
);

fabricCommand
  .command("login")
  .description("Authenticate with AceTeam platform")
  .action(async () => {
    const rl = createInterface({ input: stdin, output: stdout });

    console.log(chalk.bold("\nFabric Login\n"));

    const config = loadConfig();

    const defaultUrl = config.fabric_url || "https://app.aceteam.ai";
    const urlInput = await rl.question(
      `API URL [${defaultUrl}]: `
    );
    const fabricUrl = urlInput.trim() || defaultUrl;

    const apiKeyInput = await rl.question("API Key: ");
    if (!apiKeyInput.trim()) {
      output.error("API key is required");
      rl.close();
      process.exit(1);
    }

    const spinner = ora("Verifying connection...").start();

    try {
      const client = new FabricClient(fabricUrl, apiKeyInput.trim());
      await client.status();
      spinner.succeed("Connected to Fabric");
    } catch (err) {
      spinner.fail("Connection failed");
      output.error(String(err));
      rl.close();
      process.exit(1);
    }

    config.fabric_url = fabricUrl;
    config.fabric_api_key = apiKeyInput.trim();
    saveConfig(config);

    output.success(`Fabric credentials saved`);
    output.info(`URL: ${fabricUrl}`);

    rl.close();
  });

fabricCommand
  .command("discover")
  .description("Discover available Citadel nodes")
  .option("--capability <tag>", "Filter by capability tag")
  .action(async (options: { capability?: string }) => {
    const { url, apiKey } = requireFabricConfig();
    const client = new FabricClient(url, apiKey);

    const spinner = ora("Discovering nodes...").start();

    try {
      const result = await client.discover(options.capability);
      spinner.stop();

      const nodes = result as Array<Record<string, unknown>>;

      if (!Array.isArray(nodes) || nodes.length === 0) {
        output.warn("No nodes found");
        return;
      }

      output.printTable(
        ["ID", "Name", "Status", "Capabilities"],
        nodes.map((n) => [
          String(n.id || ""),
          String(n.name || ""),
          String(n.status || ""),
          Array.isArray(n.capabilities)
            ? n.capabilities.join(", ")
            : String(n.capabilities || ""),
        ])
      );
    } catch (err) {
      spinner.fail("Discovery failed");
      output.error(String(err));
      process.exit(1);
    }
  });

fabricCommand
  .command("status")
  .description("Show connected nodes and services")
  .action(async () => {
    const { url, apiKey } = requireFabricConfig();
    const client = new FabricClient(url, apiKey);

    const spinner = ora("Fetching node status...").start();

    try {
      const result = await client.status();
      spinner.stop();

      const nodes = result as Array<Record<string, unknown>>;

      if (!Array.isArray(nodes) || nodes.length === 0) {
        output.warn("No nodes available");
        return;
      }

      output.printTable(
        ["ID", "Name", "CPU %", "Memory %", "GPU %", "Score"],
        nodes.map((n) => [
          String(n.id || ""),
          String(n.name || ""),
          String(n.cpuPercent ?? n.cpu ?? ""),
          String(n.memPercent ?? n.mem ?? ""),
          String(n.gpuPercent ?? n.gpu ?? ""),
          String(n.score ?? ""),
        ])
      );
    } catch (err) {
      spinner.fail("Failed to fetch status");
      output.error(String(err));
      process.exit(1);
    }
  });
