export async function withCommandSignal<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Interrupted"));
  process.on("SIGINT", interrupt);
  try {
    return await operation(controller.signal);
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}
