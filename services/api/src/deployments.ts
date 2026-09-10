import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { type Hex, zeroAddress, zeroHash } from "viem";
import {
  type DeploymentChain,
  DeploymentMismatch,
  type DeploymentParameters,
} from "./deployment-chain.js";
import { type EnrollmentPolicy, EnrollmentRejected } from "./enrollment.js";

/// Prepares only a verified primary key. Backup/recovery enrollment is a separate owner command.
export class DeploymentService {
  constructor(
    private readonly pool: Pool,
    readonly chain: DeploymentChain,
    private readonly policy: EnrollmentPolicy,
  ) {}

  async process(token: string, confirm = false) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new EnrollmentRejected();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await db.query(
        "SELECT * FROM account_enrollments WHERE token_hash=$1 AND status='verified' AND verified_at > clock_timestamp()-interval '30 minutes' FOR UPDATE",
        [createHash("sha256").update(token).digest("hex")],
      );
      const enrollment = result.rows[0];
      if (
        !enrollment ||
        enrollment.rp_id !== this.policy.rpId ||
        enrollment.origin !== this.policy.origin
      )
        throw new EnrollmentRejected();
      const stored = (
        await db.query("SELECT * FROM account_deployments WHERE enrollment_id=$1", [enrollment.id])
      ).rows[0];
      if (stored && stored.manifest_hash !== this.chain.manifestHash)
        throw new DeploymentMismatch("manifest changed");
      if (confirm && !stored) throw new EnrollmentRejected();
      const parameters: DeploymentParameters = stored?.parameters ?? {
        owners: {
          primary: enrollment.coordinates,
          backup: { x: zeroHash, y: zeroHash },
          recovery: zeroAddress,
        },
        rpId: enrollment.rp_id,
        origin: enrollment.origin,
        salt: `0x${randomBytes(32).toString("hex")}` as Hex,
      };
      const prepared = await this.chain.prepare(parameters);
      if (stored && stored.account_address !== prepared.account)
        throw new DeploymentMismatch("address changed");
      if (!stored)
        await db.query(
          "INSERT INTO account_deployments (enrollment_id,manifest_hash,user_salt,account_address,parameters) VALUES ($1,$2,$3,$4,$5)",
          [
            enrollment.id,
            this.chain.manifestHash,
            parameters.salt,
            prepared.account,
            JSON.stringify(parameters),
          ],
        );
      const observation = await this.chain.confirm(prepared.account, parameters);
      if (observation.status === "confirmed")
        await db.query(
          "UPDATE account_deployments SET verified_block=$2,verified_block_hash=$3 WHERE enrollment_id=$1",
          [enrollment.id, observation.block, observation.blockHash],
        );
      await db.query("COMMIT");
      return {
        ...prepared,
        ...observation,
        parameters,
        manifest: this.chain.manifest,
        manifestHash: this.chain.manifestHash,
      };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
}
