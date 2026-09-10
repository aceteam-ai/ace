// Synthetic app-server fixture. No Codex installation, model, account, or network access.
import { createInterface } from "node:readline";
const mode = process.argv[2];
if (mode === "version") {
  console.log("codex-cli 0.153.4");
} else {
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const turn = (status) => ({ id: "turn-synthetic", status, items: [], error: null });
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") send({ id: request.id, result: { userAgent: "synthetic-codex/0.153.4" } });
    if (request.method === "account/read") send({ id: request.id, result: { account: null, requiresOpenaiAuth: false } });
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-synthetic" }, model: "synthetic-model", modelProvider: "synthetic", cwd: request.params.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly" } } });
    if (request.method === "turn/start") {
      send({ id: request.id, result: { turn: turn("inProgress") } });
      const params = { threadId: "thread-synthetic", turnId: "turn-synthetic" };
      if (mode === "exit") process.exit(17);
      else {
        send({ method: "item/agentMessage/delta", params: { ...params, itemId: "message-synthetic", delta: "Synthetic reply" } });
        send({ method: "item/completed", params: { ...params, item: { type: "agentMessage", id: "message-synthetic", text: "Synthetic reply" } } });
        send({ method: "turn/completed", params: { threadId: params.threadId, turn: turn("completed") } });
      }
    }
  });
}
