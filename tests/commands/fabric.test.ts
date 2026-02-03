import { describe, it, expect } from "vitest";
import { fabricCommand } from "../../src/commands/fabric.js";

describe("fabricCommand", () => {
  it("has login subcommand", () => {
    const login = fabricCommand.commands.find((c) => c.name() === "login");
    expect(login).toBeDefined();
    expect(login!.description()).toBe("Authenticate with AceTeam platform");
  });

  it("has discover subcommand", () => {
    const discover = fabricCommand.commands.find(
      (c) => c.name() === "discover"
    );
    expect(discover).toBeDefined();
    expect(discover!.description()).toBe("Discover available Citadel nodes");
  });

  it("has status subcommand", () => {
    const status = fabricCommand.commands.find((c) => c.name() === "status");
    expect(status).toBeDefined();
    expect(status!.description()).toBe("Show connected nodes and services");
  });

  it("discover has --capability option", () => {
    const discover = fabricCommand.commands.find(
      (c) => c.name() === "discover"
    );
    const capabilityOption = discover!.options.find(
      (o) => o.long === "--capability"
    );
    expect(capabilityOption).toBeDefined();
    expect(capabilityOption!.description).toBe("Filter by capability tag");
  });

  it("has correct top-level description", () => {
    expect(fabricCommand.description()).toBe(
      "Manage Sovereign Compute Fabric connections"
    );
  });
});
