import { PlatformClient, PlatformClientError } from "./client.js";
import type { PlatformTemplate } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPlatformTemplateId(value: string): boolean {
  return UUID.test(value);
}

export async function getPlatformTemplateById(
  client: PlatformClient,
  workflowId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PlatformTemplate> {
  if (!isPlatformTemplateId(workflowId)) {
    throw new PlatformClientError("Platform template ID must be a UUID.", "invalid_template_id");
  }
  const matches = (await client.listTemplates({ signal: options.signal }))
    .filter((summary) => summary.workflowId.toLowerCase() === workflowId.toLowerCase());
  if (matches.length === 0) throw new PlatformClientError("Platform template was not found in the authorized catalog.", "template_not_found");
  if (matches.length > 1) throw new PlatformClientError("Platform catalog returned an ambiguous template selection.", "ambiguous_template");
  return client.getTemplate(matches[0], options);
}
