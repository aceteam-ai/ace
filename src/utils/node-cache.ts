import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listNodes } from "./python.js";

const CACHE_PATH = join(homedir(), ".ace", "node-types.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface NodeTypeEntry {
  type: string;
  display_name: string;
  description: string;
}

interface NodeCache {
  timestamp: number;
  nodes: NodeTypeEntry[];
}

function readCache(): NodeCache | null {
  if (!existsSync(CACHE_PATH)) return null;

  try {
    const data = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as NodeCache;
    if (Date.now() - data.timestamp < CACHE_TTL_MS && Array.isArray(data.nodes)) {
      return data;
    }
  } catch {
    // Corrupt cache
  }
  return null;
}

function writeCache(nodes: NodeTypeEntry[]): void {
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const cache: NodeCache = { timestamp: Date.now(), nodes };
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

/**
 * Get the set of available node types, using a 24h cache.
 * Falls back to cache on Python errors. Returns null if no data available.
 */
export async function getAvailableNodeTypes(
  pythonPath: string
): Promise<Set<string> | null> {
  // Try cache first
  const cached = readCache();
  if (cached) {
    return new Set(cached.nodes.map((n) => n.type));
  }

  // Fetch from Python
  try {
    const result = await listNodes(pythonPath);
    if ("error" in result) return null;

    const nodes = result.nodes as NodeTypeEntry[];
    if (!Array.isArray(nodes)) return null;

    writeCache(nodes);
    return new Set(nodes.map((n) => n.type));
  } catch {
    return null;
  }
}

/**
 * Validate that all node types in a workflow exist.
 * Returns an array of invalid type names, or empty if all valid.
 */
export async function validateNodeTypes(
  pythonPath: string,
  workflowPath: string
): Promise<{ invalid: string[]; available: string[] }> {
  const workflow = JSON.parse(readFileSync(workflowPath, "utf-8"));

  // Support both v2 (inner_nodes) and v1 (nodes) schema
  const innerNodes = workflow.inner_nodes as Array<{ type: string }> | undefined;
  const legacyNodes = workflow.nodes as Array<{ type: string }> | undefined;
  const nodes = innerNodes || legacyNodes;
  if (!nodes || !Array.isArray(nodes)) {
    return { invalid: [], available: [] };
  }

  const usedTypes = nodes.map((n) => n.type);
  const availableTypes = await getAvailableNodeTypes(pythonPath);

  if (!availableTypes) {
    // Can't validate without node list — skip
    return { invalid: [], available: [] };
  }

  const available = [...availableTypes].sort();
  const invalid = usedTypes.filter((t) => !availableTypes.has(t));

  return { invalid: [...new Set(invalid)], available };
}
