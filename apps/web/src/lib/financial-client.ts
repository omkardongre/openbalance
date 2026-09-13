import {
  accountAbi,
  accountCommandDigest,
  type PaymentIntent,
  paymentIntentDigest,
  type ReserveChannelConfig,
  reserveChannelTermsHash,
} from "@openbalance/protocol";
import {
  type Address,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  keccak256,
  sha256,
  stringToHex,
} from "viem";
import { signAccountCommand } from "./passkey-command";

export type PasskeyIdentity = {
  account: Address;
  credentialId: string;
  sessionToken: string;
};

function client() {
  const rpcUrl = process.env.NEXT_PUBLIC_FINANCIAL_RPC_URL;
  if (!rpcUrl) throw new Error("Financial RPC is not configured.");
  return createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
}

async function context(account: Address) {
  const publicClient = client();
  const rpId = process.env.NEXT_PUBLIC_WEBAUTHN_RP_ID;
  if (!rpId) throw new Error("Passkey relying-party configuration is missing.");
  const code = await publicClient.getCode({ address: account });
  if (!code || code === "0x") throw new Error("The passkey account is not deployed.");
  const [chainId, epoch, nonce, origin, rpIdHash] = await Promise.all([
    publicClient.getChainId(),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "epoch" }),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "nonce" }),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "origin" }),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "rpIdHash" }),
  ]);
  if (
    origin !== window.location.origin ||
    rpIdHash.toLowerCase() !== sha256(stringToHex(rpId)).toLowerCase()
  )
    throw new Error("The account passkey policy does not match this site.");
  return { chainId, epoch, nonce, origin, rpId };
}

async function authorization(input: {
  identity: PasskeyIdentity;
  action: "PAY" | "CANCEL" | "OPEN_CHANNEL";
  terms: Hex;
  deadline: bigint;
}) {
  const current = await context(input.identity.account);
  const digest = accountCommandDigest({
    chainId: current.chainId,
    account: input.identity.account,
    action: input.action,
    terms: input.terms,
    epoch: current.epoch,
    nonce: current.nonce,
    deadline: input.deadline,
  });
  return signAccountCommand({
    digest,
    credentialId: input.identity.credentialId,
    rpId: current.rpId,
    origin: current.origin,
  });
}

function paymentTerms(router: Address, intent: PaymentIntent): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [router, paymentIntentDigest(intent)],
    ),
  );
}

export async function paymentCommand(input: {
  identity: PasskeyIdentity;
  intent: PaymentIntent;
  encodedIntent: Hex;
  terminalSignature: Hex;
  cancel?: boolean;
}): Promise<Hex> {
  const account = getAddress(input.identity.account);
  if (getAddress(input.intent.payerAccount) !== account)
    throw new Error("This checkout belongs to another account.");
  const deadline = BigInt(input.intent.expiresAt);
  const auth = await authorization({
    identity: { ...input.identity, account },
    action: input.cancel ? "CANCEL" : "PAY",
    terms: paymentTerms(input.intent.router, input.intent),
    deadline,
  });
  return encodeFunctionData({
    abi: accountAbi,
    functionName: input.cancel ? "cancelPayment" : "pay",
    args: [
      input.intent.router,
      input.encodedIntent,
      input.terminalSignature,
      deadline,
      false,
      auth,
    ],
  });
}

export async function reserveCommand(input: {
  identity: PasskeyIdentity;
  chainId: bigint;
  vault: Address;
  config: ReserveChannelConfig;
  maximumTotalReserve: bigint;
  deadline: bigint;
}): Promise<Hex> {
  if (input.maximumTotalReserve < input.config.reserveUnits)
    throw new Error("Reserve limit is below the requested reserve.");
  const termsHash = reserveChannelTermsHash({
    chainId: input.chainId,
    vault: input.vault,
    originalAccount: input.identity.account,
    config: input.config,
  });
  const terms = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        input.vault,
        input.config.channelId,
        input.config.reserveUnits,
        input.maximumTotalReserve,
        termsHash,
      ],
    ),
  );
  const auth = await authorization({
    identity: input.identity,
    action: "OPEN_CHANNEL",
    terms,
    deadline: input.deadline,
  });
  return encodeFunctionData({
    abi: accountAbi,
    functionName: "openReserveChannel",
    args: [input.vault, input.config, input.maximumTotalReserve, input.deadline, false, auth],
  });
}

export function financialIdempotencyKey(kind: string, aggregateId: Hex): string {
  return `financial:${kind}:${aggregateId.toLowerCase()}`;
}
