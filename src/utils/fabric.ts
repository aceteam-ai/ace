export class FabricClient {
  private url: string;
  private apiKey: string;

  constructor(url: string, apiKey: string) {
    this.url = url.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private async request(
    path: string,
    options: RequestInit = {}
  ): Promise<unknown> {
    const response = await fetch(`${this.url}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Fabric API error (${response.status}): ${body || response.statusText}`
      );
    }

    return response.json();
  }

  async discover(capability?: string): Promise<unknown> {
    const params = new URLSearchParams();
    if (capability) {
      params.set("capability", capability);
    }
    const query = params.toString();
    const path = `/api/fabric/discover/nodes${query ? `?${query}` : ""}`;
    return this.request(path);
  }

  async status(): Promise<unknown> {
    return this.request("/api/fabric/nodes/load");
  }

  async enqueueWorkflow(
    workflow: object,
    input: Record<string, string>
  ): Promise<unknown> {
    return this.request("/api/fabric/call", {
      method: "POST",
      body: JSON.stringify({ workflow, input }),
    });
  }
}
