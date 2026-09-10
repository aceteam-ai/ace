import type { HandoffReview } from "../harness/handoff.js";
import { NativeSessionManager } from "../harness/session-manager.js";
import type { CommandAccepted, NativeHarnessCommandResult } from "../harness/types.js";
import { NativeSessionService } from "./native-session-service.js";

type HandoffResult = NativeHarnessCommandResult<CommandAccepted>;

/** Owns managed native connections across view navigation. Provider construction performs no native work. */
export class NativeWorkspaceController {
  private readonly services = new Map<string, NativeSessionService>();
  private readonly handoffServices = new WeakMap<HandoffReview, NativeSessionService>();
  private readonly handoffs = new WeakMap<HandoffReview, Promise<HandoffResult>>();
  private readonly cancelledHandoffs = new WeakSet<HandoffReview>();
  private readonly cancellations = new WeakMap<HandoffReview, Promise<boolean>>();
  private readonly operations = new Set<Promise<unknown>>();
  private disposed = false;
  selectedId?: string;
  constructor(readonly manager: NativeSessionManager) {}
  get providerIds(): readonly string[] { return this.manager.adapterIds; }
  get selectedService(): NativeSessionService | undefined { return this.selectedId ? this.services.get(this.selectedId) : undefined; }
  canBeginHandoff = (): boolean => !this.disposed && [...this.services.values()].every((service) => service.canStartFresh());

  select(providerId: string): NativeSessionService {
    if (this.disposed || !this.providerIds.includes(providerId)) throw new Error("This native provider is unavailable.");
    if ([...this.services.entries()].some(([id, service]) => id !== providerId && !service.canStartFresh())) {
      throw new Error("Close the current native session before choosing another provider.");
    }
    let service = this.services.get(providerId);
    if (!service) {
      const adapter = this.manager.createAdapter(providerId, { onNotice: (notice) => service?.reportRegistrationNotice(notice) });
      service = new NativeSessionService(adapter); this.services.set(providerId, service);
    }
    this.selectedId = providerId;
    return service;
  }

  runLocalOperation = <T>(action: () => Promise<T>): Promise<T> => {
    const operation = Promise.resolve().then(() => {
      if (this.disposed) throw new Error("The native workspace is closing.");
      return action();
    });
    this.operations.add(operation);
    return operation.finally(() => { this.operations.delete(operation); });
  };

  handoffService(review: HandoffReview): NativeSessionService | undefined { return this.handoffServices.get(review); }

  /** The review component alone calls this after explicit confirmation; duplicate keys share the same outcome. */
  confirmHandoff(review: HandoffReview): Promise<HandoffResult> {
    const existing = this.handoffs.get(review);
    if (existing) return existing;
    const operation = this.runLocalOperation(async (): Promise<HandoffResult> => {
      if (this.cancelledHandoffs.has(review)) return { status: "rejected", code: "invalid_state", message: "The handoff was cancelled before opening a native session." };
      if (!this.canBeginHandoff()) return { status: "rejected", code: "invalid_state", message: "Close the current native session before starting a handoff." };
      let service: NativeSessionService;
      try { service = this.select(review.target.adapterId); }
      catch { return { status: "rejected", code: "adapter_mismatch", message: "The selected handoff provider is unavailable." }; }
      this.handoffServices.set(review, service);
      return service.startWithInput(review.target.workspace, review.input, review.workspaceIdentity, review);
    });
    this.handoffs.set(review, operation);
    return operation;
  }

  /** Stop only this review's owned connection; cancellation never resumes or repeats input. */
  cancelHandoff(review: HandoffReview): Promise<boolean> {
    const existing = this.cancellations.get(review);
    if (existing) return existing;
    this.cancelledHandoffs.add(review); // Also cancels confirmation queued before provider selection.
    const operation = Promise.resolve().then(async () => {
      const service = this.handoffServices.get(review);
      const closed = service ? await service.cancelInitialInput(review) : true;
      await this.handoffs.get(review)?.catch(() => undefined);
      const eventual = this.handoffServices.get(review);
      return !service && eventual ? eventual.cancelInitialInput(review) : closed;
    }).finally(() => { this.operations.delete(operation); });
    this.operations.add(operation);
    this.cancellations.set(review, operation);
    return operation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.services.values()].map((service) => service.dispose()));
    await Promise.allSettled([...this.operations]);
  }
}
