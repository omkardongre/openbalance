import {
  type DeploymentManifest,
  type FinalizedChannelProof,
  type VerificationReader,
  verifyFinalizedChannel,
} from "@openbalance/verifier";
import type { Hex } from "viem";
import type { TerminalJournal } from "./journal.js";

export type BootstrapFinalizedChannelInput = {
  journal: TerminalJournal;
  reader: VerificationReader;
  manifest: DeploymentManifest;
  channelId: Hex;
  installedAt?: number;
};

export type InstalledChannelProof = FinalizedChannelProof & { created: boolean };

/** Verify one finalized onchain snapshot before making a channel usable offline. */
export async function bootstrapFinalizedChannel(
  input: BootstrapFinalizedChannelInput,
): Promise<InstalledChannelProof> {
  const proof = await verifyFinalizedChannel(input.reader, input.manifest, input.channelId);
  const result = input.journal.registerChannel(
    {
      chainId: proof.chainId,
      vault: proof.vault,
      terminalSigner: proof.terminalSigner,
      config: proof.config,
    },
    input.installedAt,
  );
  return { ...proof, created: result.created };
}
