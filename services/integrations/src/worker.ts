import type { ErpNextClient } from "./erpnext.js";
import { PartnerResponseRejected, PartnerUnavailable } from "./http.js";
import type { IntegrationJobJournal } from "./journal.js";

export class IntegrationWorker {
  constructor(
    private readonly journal: IntegrationJobJournal,
    private readonly erpNext: ErpNextClient,
    private readonly owner: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<"IDLE" | "COMPLETED" | "RETRY" | "QUARANTINED"> {
    const job = await this.journal.lease(this.owner, this.now());
    if (!job) return "IDLE";
    try {
      const result = await this.erpNext.recordFinalizedPayment(job.payment);
      await this.journal.complete(job, result);
      return "COMPLETED";
    } catch (error) {
      const retryable = error instanceof PartnerUnavailable;
      const code =
        error instanceof PartnerUnavailable
          ? "partner_unavailable"
          : error instanceof PartnerResponseRejected
            ? "partner_response_rejected"
            : "integration_contract_rejected";
      await this.journal.fail(job, code, retryable, this.now());
      return retryable && job.attempts < 8 ? "RETRY" : "QUARANTINED";
    }
  }
}
