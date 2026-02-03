import { describe, it, expect, vi, beforeEach } from "vitest";
import { FabricClient } from "../../src/utils/fabric.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: "test" }),
    text: () => Promise.resolve("error body"),
  });
});

describe("FabricClient", () => {
  describe("constructor", () => {
    it("strips trailing slashes from URL", () => {
      const client = new FabricClient("https://example.com///", "key");
      // Verify by calling a method and checking the URL passed to fetch
      client.status();
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/api/fabric/nodes/load",
        expect.any(Object)
      );
    });
  });

  describe("discover()", () => {
    it("calls the correct endpoint", async () => {
      const client = new FabricClient("https://example.com", "key");
      await client.discover();
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/api/fabric/discover/nodes",
        expect.any(Object)
      );
    });

    it("passes capability query param", async () => {
      const client = new FabricClient("https://example.com", "key");
      await client.discover("gpu:a100");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/api/fabric/discover/nodes?capability=gpu%3Aa100",
        expect.any(Object)
      );
    });
  });

  describe("status()", () => {
    it("calls the correct endpoint", async () => {
      const client = new FabricClient("https://example.com", "key");
      await client.status();
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/api/fabric/nodes/load",
        expect.any(Object)
      );
    });
  });

  describe("enqueueWorkflow()", () => {
    it("sends POST with correct body", async () => {
      const client = new FabricClient("https://example.com", "key");
      const workflow = { nodes: [] };
      const input = { prompt: "hello" };
      await client.enqueueWorkflow(workflow, input);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/api/fabric/call",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ workflow, input }),
        })
      );
    });
  });

  describe("request()", () => {
    it("adds auth header", async () => {
      const client = new FabricClient("https://example.com", "my-secret-key");
      await client.status();

      const callArgs = mockFetch.mock.calls[0];
      const options = callArgs[1];
      expect(options.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer my-secret-key",
          "Content-Type": "application/json",
        })
      );
    });

    it("throws on non-OK response with status and body", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve("Access denied"),
      });

      const client = new FabricClient("https://example.com", "key");
      await expect(client.status()).rejects.toThrow(
        "Fabric API error (403): Access denied"
      );
    });

    it("throws with statusText when body is empty", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve(""),
      });

      const client = new FabricClient("https://example.com", "key");
      await expect(client.status()).rejects.toThrow(
        "Fabric API error (500): Internal Server Error"
      );
    });
  });
});
