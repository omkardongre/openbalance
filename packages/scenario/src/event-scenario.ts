import { randomBytes } from "node:crypto";
import {
  accountAbi,
  accountFactoryAbi,
  encodeOfflineVoucher,
  terminalIngressDigest,
  type VoucherReceipt,
  voucherReceiptPayloadHash,
} from "@openbalance/protocol";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  type Hex,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor } from "./account-scenario.js";
import { loadArtifact } from "./artifacts.js";
import { VirtualAuthenticator } from "./authenticator.js";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);
const vaultReads = parseAbi([
  "function reservedFor(address) view returns (uint256)",
  "function totalReserved() view returns (uint256)",
  "function channelState(bytes32) view returns (address originalAccount, uint256 spentGross, uint32 nextSequence, bytes32 lastVoucherDigest, bool reclaimed)",
  "function channelTermsHash((bytes32 channelId,bytes32 eventId,address asset,uint256 reserveUnits,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,uint256 terminalKeyVersion,address attendeeChannelSigner,uint256 configVersion,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 maxPerVoucher,uint32 maxVoucherCount,uint48 acceptFrom,uint48 acceptUntil,uint48 submitUntil,bytes32 genesisDigest) config,address originalAccount) view returns (bytes32)",
  "function voucherDigest((uint32 protocolVersion,uint256 chainId,address vault,bytes32 channelId,uint32 sequence,bytes32 previousVoucherDigest,bytes32 paymentId,bytes32 orderRefHash,uint256 grossUnits,uint256 cumulativeGrossUnits,bytes32 receiptCommitment,uint48 acceptedAt,uint48 acceptUntil,uint48 submitUntil,uint256 configVersion) voucher) view returns (bytes32)",
]);
const registryReads = parseAbi([
  "function destinationDigest(bytes32 vendorId,uint256 version,address destination,uint256 deadline) view returns (bytes32)",
]);

const OPEN_CHANNEL = keccak256(stringToHex("OPEN_CHANNEL"));
const b32 = (label: string) => keccak256(stringToHex(label));

export type OfflineReserveOptions = {
  rpcUrl: string;
  deployerPrivateKey: Hex;
  rpId?: string;
  origin?: string;
};

export type OfflineReserveContext = {
  chainId: number;
  rpcUrl: string;
  token: Address;
  registry: Address;
  ledger: Address;
  vault: Address;
  account: Address;
  channelId: Hex;
  terminalId: Hex;
  terminalSignerAddress: Address;
  reserveUnits: bigint;
  grossUnits: bigint;
  submitUntil: number;
  receipt: Record<string, unknown>;
  relayAudience: (relayUrl: string) => Promise<{ receipt: unknown; authorization: unknown }>;
  settle: () => Promise<void>;
  reclaim: () => Promise<void>;
  advance: (seconds: number) => Promise<void>;
  rejectReplay: () => Promise<boolean>;
  rejectEarlyReclaim: () => Promise<boolean>;
  rejectLateSettlement: () => Promise<boolean>;
  readAccountBalance: () => Promise<bigint>;
  readLedgerCustody: () => Promise<bigint>;
  readReserved: () => Promise<bigint>;
  close?: () => Promise<void>;
};

export type OfflineReserveResult = {
  chainId: number;
  token: Address;
  registry: Address;
  ledger: Address;
  vault: Address;
  account: Address;
  channelId: Hex;
  reserveUnits: string;
  settledUnits: string;
  reclaimedUnits: string;
  accountFinalBalance: string;
  ledgerCustody: string;
  replayRejected: boolean;
  earlyReclaimRejected: boolean;
  lateSettlementRejected: boolean;
};

/**
 * Configures an event, opens a terminal-scoped reserve channel through a WebAuthn-authorized
 * account and produces a dual-signed voucher. The returned context lets a caller settle in
 * process or deliver the receipt through the venue relay; the remaining reserve can be reclaimed
 * after the submission deadline.
 */
export async function prepareOfflineReserve(
  options: OfflineReserveOptions,
): Promise<OfflineReserveContext> {
  const rpId = options.rpId ?? "localhost";
  const origin = options.origin ?? "http://localhost:3000";
  const chain = chainFor(options.rpcUrl);
  const deployer = privateKeyToAccount(options.deployerPrivateKey);
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(options.rpcUrl), account: deployer });
  const vendorAuthority = privateKeyToAccount(keccak256(stringToHex("vendor:authority")));
  const terminalSigner = privateKeyToAccount(keccak256(stringToHex("terminal:signer")));
  const channelSigner = privateKeyToAccount(keccak256(stringToHex("attendee:channel")));

  const tokenArtifact = loadArtifact("LocalTestToken.sol", "LocalTestToken");
  const accountFactoryArtifact = loadArtifact("AccountFactory.sol", "AccountFactory");
  const eventFactoryArtifact = loadArtifact("EventFactory.sol", "EventFactory");
  const vaultArtifact = loadArtifact("ResilienceVault.sol", "ResilienceVault");
  const registryArtifact = loadArtifact("EventRegistry.sol", "EventRegistry");

  const token = await deploy(publicClient, wallet, tokenArtifact, [
    deployer.address,
    1_000_000_000_000n,
  ]);
  const accountFactory = await deploy(publicClient, wallet, accountFactoryArtifact, []);
  const eventFactory = await deploy(publicClient, wallet, eventFactoryArtifact, []);

  const eventId = b32("event:scenario");
  const deployHash = await wallet.writeContract({
    address: eventFactory,
    abi: eventFactoryArtifact.abi,
    functionName: "deployEvent",
    args: [eventId, token, deployer.address, 1_000],
    account: deployer,
    chain,
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== "success") throw new Error("Event deployment reverted");
  const deployment = (await publicClient.readContract({
    address: eventFactory,
    abi: eventFactoryArtifact.abi,
    functionName: "getDeployment",
    args: [deployer.address, eventId],
  })) as { registry: Address; ledger: Address; router: Address; vault: Address };
  const { registry, ledger, vault } = deployment;

  const passkey = VirtualAuthenticator.create({ rpId, origin });
  const recovery = privateKeyToAccount(keccak256(stringToHex("recovery:signer")));
  const ownership = {
    primary: passkey.publicKey,
    backup: { x: `0x${"00".repeat(32)}` as Hex, y: `0x${"00".repeat(32)}` as Hex },
    recovery: recovery.address,
  };
  const userSalt = b32("salt");
  const account = (await publicClient.readContract({
    address: accountFactory,
    abi: accountFactoryAbi,
    functionName: "predict",
    args: [ownership, passkey.rpIdHash, origin, userSalt],
  })) as Address;
  await send(wallet, publicClient, {
    address: accountFactory,
    abi: accountFactoryAbi,
    functionName: "create",
    args: [ownership, passkey.rpIdHash, origin, userSalt],
  });

  const now = Number((await publicClient.getBlock()).timestamp);
  const reserveUnits = 20_000_000n;
  const grossUnits = 6_000_000n;
  const funding = reserveUnits + 5_000_000n;
  await send(wallet, publicClient, {
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [account, funding],
  });

  const vendorId = b32("vendor:scenario");
  const terminalId = b32("terminal:scenario");
  await send(wallet, publicClient, {
    address: registry,
    abi: registryArtifact.abi,
    functionName: "registerConfig",
    args: [
      1n,
      {
        validAfter: now,
        validUntil: now + 86_400,
        organizerFeeBps: 200,
        platformFeeBps: 100,
        maximumAcceptanceDuration: 3_600,
        maximumSubmissionDelay: 3_600,
        organizerDestination: deployer.address,
        platformDestination: deployer.address,
        termsHash: b32("terms:scenario"),
        enabled: true,
      },
    ],
  });
  await send(wallet, publicClient, {
    address: registry,
    abi: registryArtifact.abi,
    functionName: "registerVendor",
    args: [vendorId, vendorAuthority.address],
  });
  const destinationDeadline = BigInt(now + 3_600);
  const destinationDigest = (await publicClient.readContract({
    address: registry,
    abi: registryReads,
    functionName: "destinationDigest",
    args: [vendorId, 1n, deployer.address, destinationDeadline],
  })) as Hex;
  await send(wallet, publicClient, {
    address: registry,
    abi: registryArtifact.abi,
    functionName: "registerDestination",
    args: [
      vendorId,
      1n,
      deployer.address,
      destinationDeadline,
      await vendorAuthority.sign({ hash: destinationDigest }),
    ],
  });
  await send(wallet, publicClient, {
    address: registry,
    abi: registryArtifact.abi,
    functionName: "registerTerminal",
    args: [terminalId, 1n, vendorId, terminalSigner.address, now, now + 86_400],
  });

  const channelId = b32("channel:scenario");
  const acceptFrom = now + 60;
  const acceptUntil = now + 3_600;
  const submitUntil = now + 7_200;
  const channelConfig = {
    channelId,
    eventId,
    asset: token,
    reserveUnits,
    vendorId,
    vendorDestinationVersion: 1n,
    terminalInstanceId: terminalId,
    terminalKeyVersion: 1n,
    attendeeChannelSigner: channelSigner.address,
    configVersion: 1n,
    organizerFeeBps: 200,
    platformFeeBps: 100,
    maxPerVoucher: 10_000_000n,
    maxVoucherCount: 10,
    acceptFrom,
    acceptUntil,
    submitUntil,
    genesisDigest: b32("genesis:scenario"),
  };
  const termsHash = (await publicClient.readContract({
    address: vault,
    abi: vaultReads,
    functionName: "channelTermsHash",
    args: [channelConfig, account],
  })) as Hex;
  const openTerms = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [vault, channelId, reserveUnits, reserveUnits, termsHash],
    ),
  );
  const openDeadline = BigInt(now + 3_600);
  const openDigest = (await publicClient.readContract({
    address: account,
    abi: accountAbi,
    functionName: "commandDigest",
    args: [OPEN_CHANNEL, openTerms, openDeadline],
  })) as Hex;
  await send(wallet, publicClient, {
    address: account,
    abi: accountAbi,
    functionName: "openReserveChannel",
    args: [vault, channelConfig, reserveUnits, openDeadline, false, authOf(passkey, openDigest)],
  });
  await advanceTime(publicClient, 90);

  const voucher = {
    protocolVersion: 1,
    chainId: BigInt(chain.id),
    vault,
    channelId,
    sequence: 1,
    previousVoucherDigest: channelConfig.genesisDigest,
    paymentId: b32("payment:scenario:1"),
    orderRefHash: b32("order:scenario:1"),
    grossUnits,
    cumulativeGrossUnits: grossUnits,
    receiptCommitment: b32("receipt:scenario:1"),
    acceptedAt: acceptFrom,
    acceptUntil,
    submitUntil,
    configVersion: 1n,
  };
  const voucherDigest = (await publicClient.readContract({
    address: vault,
    abi: vaultReads,
    functionName: "voucherDigest",
    args: [voucher],
  })) as Hex;
  const attendeeSignature = await channelSigner.sign({ hash: voucherDigest });
  const terminalSignature = await terminalSigner.sign({ hash: voucherDigest });
  const receipt = {
    receiptId: "receipt:scenario:1",
    terminalId,
    channelId,
    sequence: 1,
    paymentId: voucher.paymentId,
    voucher: encodeOfflineVoucher(voucher),
    attendeeSignature,
    terminalSignature,
  };

  const settle = async () => {
    await send(wallet, publicClient, {
      address: vault,
      abi: vaultArtifact.abi,
      functionName: "settleVoucher",
      args: [voucher, attendeeSignature, terminalSignature],
    });
  };
  const reclaim = async () => {
    await send(wallet, publicClient, {
      address: vault,
      abi: vaultArtifact.abi,
      functionName: "reclaim",
      args: [channelId],
    });
  };

  return {
    chainId: chain.id,
    rpcUrl: options.rpcUrl,
    token,
    registry,
    ledger,
    vault,
    account,
    channelId,
    terminalId,
    terminalSignerAddress: terminalSigner.address,
    reserveUnits,
    grossUnits,
    submitUntil,
    receipt,
    relayAudience: async (relayUrl: string) => {
      const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
      const sentAt = Math.floor(Date.now() / 1_000);
      const payloadHash = voucherReceiptPayloadHash(receipt as unknown as VoucherReceipt);
      const digest = terminalIngressDigest({
        audience: relayUrl,
        terminalId,
        keyVersion: 1n,
        sentAt,
        nonce,
        payloadHash: `0x${payloadHash}` as Hex,
      });
      return {
        // A copy so a caller cannot mutate the shared receipt while building conflict cases.
        receipt: { ...receipt },
        authorization: {
          keyVersion: "1",
          sentAt,
          nonce,
          signature: await terminalSigner.sign({ hash: digest }),
        },
      };
    },
    settle,
    reclaim,
    advance: (seconds: number) => advanceTime(publicClient, seconds),
    rejectReplay: () =>
      rejects(() =>
        wallet.writeContract({
          address: vault,
          abi: vaultArtifact.abi,
          functionName: "settleVoucher",
          args: [voucher, attendeeSignature, terminalSignature],
          account: deployer,
          chain,
        }),
      ),
    rejectEarlyReclaim: () =>
      rejects(() =>
        wallet.writeContract({
          address: vault,
          abi: vaultArtifact.abi,
          functionName: "reclaim",
          args: [channelId],
          account: deployer,
          chain,
        }),
      ),
    rejectLateSettlement: () =>
      rejects(async () => {
        await advanceTime(publicClient, submitUntil - now + 10);
        return wallet.writeContract({
          address: vault,
          abi: vaultArtifact.abi,
          functionName: "settleVoucher",
          args: [
            {
              ...voucher,
              sequence: 2,
              previousVoucherDigest: voucherDigest,
              paymentId: b32("payment:scenario:2"),
            },
            attendeeSignature,
            terminalSignature,
          ],
          account: deployer,
          chain,
        });
      }),
    readAccountBalance: () =>
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      }) as Promise<bigint>,
    readLedgerCustody: () =>
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ledger],
      }) as Promise<bigint>,
    readReserved: () =>
      publicClient.readContract({
        address: vault,
        abi: vaultReads,
        functionName: "reservedFor",
        args: [account],
      }) as Promise<bigint>,
  };
}

/**
 * Runs the complete offline-reserve money path in process and asserts the adversarial
 * rejections and exact custody conservation.
 */
export async function runOfflineReserveScenario(
  options: OfflineReserveOptions,
): Promise<OfflineReserveResult> {
  const context = await prepareOfflineReserve(options);
  await context.settle();
  const replayRejected = await context.rejectReplay();
  const earlyReclaimRejected = await context.rejectEarlyReclaim();
  const lateSettlementRejected = await context.rejectLateSettlement();
  await context.reclaim();

  const accountFinalBalance = await context.readAccountBalance();
  const ledgerCustody = await context.readLedgerCustody();
  const remaining = await context.readReserved();
  const reclaimedUnits = context.reserveUnits - context.grossUnits;
  const expectedBalance = context.reserveUnits + 5_000_000n - context.grossUnits;
  if (remaining !== 0n) throw new Error("Reserve was not fully returned to the attendee");
  if (accountFinalBalance !== expectedBalance)
    throw new Error("Attendee balance does not reflect settled spend and returned reserve");
  if (ledgerCustody !== context.grossUnits)
    throw new Error("Ledger custody does not equal settled gross");

  return {
    chainId: context.chainId,
    token: context.token,
    registry: context.registry,
    ledger: context.ledger,
    vault: context.vault,
    account: context.account,
    channelId: context.channelId,
    reserveUnits: context.reserveUnits.toString(),
    settledUnits: context.grossUnits.toString(),
    reclaimedUnits: reclaimedUnits.toString(),
    accountFinalBalance: accountFinalBalance.toString(),
    ledgerCustody: ledgerCustody.toString(),
    replayRejected,
    earlyReclaimRejected,
    lateSettlementRejected,
  };
}

async function deploy(
  publicClient: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  artifact: { abi: readonly unknown[]; bytecode: `0x${string}` },
  args: readonly unknown[],
): Promise<Address> {
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    account: wallet.account as Account,
    chain: wallet.chain as Chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress)
    throw new Error("Scenario contract deployment failed");
  return receipt.contractAddress;
}

async function send(
  wallet: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  call: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  },
): Promise<void> {
  const hash = await wallet.writeContract({
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    account: wallet.account as Account,
    chain: wallet.chain as Chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${call.functionName} reverted`);
}

async function advanceTime(
  publicClient: ReturnType<typeof createPublicClient>,
  seconds: number,
): Promise<void> {
  await publicClient.request({ method: "evm_increaseTime", params: [seconds] } as never);
  await publicClient.request({ method: "evm_mine", params: [] } as never);
}

async function rejects(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

function authOf(passkey: VirtualAuthenticator, digest: Hex) {
  const assertion = passkey.assert(digest);
  return {
    r: assertion.r,
    s: assertion.s,
    challengeIndex: assertion.challengeIndex,
    typeIndex: assertion.typeIndex,
    authenticatorData: assertion.authenticatorData,
    clientDataJSON: assertion.clientDataJSON,
  };
}
