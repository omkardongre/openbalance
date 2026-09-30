import { readFile, writeFile } from "node:fs/promises";
import {
  type AttendeeChannelState,
  createAttendeeChannelState,
  prepareAttendeeAuthorization,
  verifyTerminalReceiptForAuthorization,
} from "@openbalance/attendee";
import {
  canonicalVoucherReceipt,
  decodeOfflineVoucher,
  decodePaymentRequestQr,
  decodeVoucherReceipt,
  encodeAttendeeResponseQr,
  paymentRequestHash,
  type ReserveChannelConfig,
  type TerminalPaymentRequest,
  type VoucherReceipt,
} from "@openbalance/protocol";
import {
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import {
  type Address,
  createPublicClient,
  getAddress,
  type Hex,
  http,
  keccak256,
  parseAbi,
  recoverAddress,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Headless attendee wallet for a reserve channel opened by the treasury scenario. It is the same
 * authorization path the web wallet runs (`prepareAttendeeAuthorization`, then a raw-digest
 * secp256k1 signature), so a physical terminal can be exercised end to end without a second phone.
 *
 * The channel key is re-derived from the run id on every use and never written to disk; the state
 * file holds only the channel binding, the approval chain and the terminal receipts.
 */

const vaultAbi = parseAbi([
  "function channelConfig(bytes32 channelId) view returns ((bytes32 channelId,bytes32 eventId,address asset,uint256 reserveUnits,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,uint256 terminalKeyVersion,address attendeeChannelSigner,uint256 configVersion,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 maxPerVoucher,uint32 maxVoucherCount,uint48 acceptFrom,uint48 acceptUntil,uint48 submitUntil,bytes32 genesisDigest))",
  "function channelState(bytes32 channelId) view returns (address originalAccount,uint256 spentGross,uint32 nextSequence,bytes32 lastVoucherDigest,bool reclaimed)",
]);
const registryAbi = parseAbi([
  "function terminals(bytes32 terminalId,uint256 version) view returns (bytes32 vendorId,address signer,uint48 validAfter,uint48 validUntil,bool enabled)",
]);
const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

type Authorization = {
  paymentId: Hex;
  request: TerminalPaymentRequest;
  requestHash: Hex;
  attendeeSignature: Hex;
  responseQr: string;
  receipt: VoucherReceipt | null;
  /** The payment that replaced this approval after the terminal abandoned it unconfirmed. */
  supersededBy?: Hex;
};

type WalletFile = {
  schemaVersion: 1;
  runId: string;
  state: AttendeeChannelState;
  authorizations: Authorization[];
};

export type AttendeeSignerOptions = {
  rpcUrl: string;
  walletPath: string;
  runId: string;
  vault: Address;
  registry: Address;
  vendorName: string;
  /** An `obqr1:` request, a terminal receipt JSON, or a PNG path holding either as a QR code. */
  input: string;
  /** Where the response QR is written as PNG when a request is approved. */
  responsePngPath: string;
  nowSeconds?: number;
};

export type AttendeeSignerResult =
  | {
      kind: "attendee-authorized";
      paymentId: Hex;
      sequence: number;
      grossUnits: string;
      cumulativeGrossUnits: string;
      remainingUnits: string;
      responsePngPath: string;
      responseQr: string;
    }
  | { kind: "attendee-receipt-stored"; paymentId: Hex; sequence: number };

const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? { $bigint: item.toString() } : item,
  );
const parse = <T>(text: string): T =>
  JSON.parse(text, (_key, item) =>
    item && typeof item === "object" && typeof item.$bigint === "string"
      ? BigInt(item.$bigint)
      : item,
  ) as T;

export function channelSignerFor(runId: string) {
  return privateKeyToAccount(keccak256(stringToHex(`channel-signer:${runId}`)));
}

function readQr(luminance: Uint8ClampedArray, width: number, height: number, pure: boolean) {
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(luminance, width, height)),
  );
  const hints = new Map<DecodeHintType, boolean>([[DecodeHintType.TRY_HARDER, true]]);
  if (pure) hints.set(DecodeHintType.PURE_BARCODE, true);
  return new QRCodeReader().decode(bitmap, hints).getText();
}

/**
 * Screenshot fallback for dense codes, or several codes on one screen, where the detector's
 * perspective sampling misses. A screenshot is pixel-exact, so each code is located by the top
 * edge of its top-left finder pattern (a dark run with light above and to its left), its module
 * grid is sampled at module centres, and the result is redrawn as a clean code for the reader.
 * Candidates are tried from the top; one cut off by the screen edge simply fails to decode.
 */
function decodeScreenshotGrid(luminance: Uint8ClampedArray, width: number, height: number) {
  const dark = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && (luminance[y * width + x] ?? 255) < 128;
  const runFrom = (x: number, y: number) => {
    let run = 0;
    while (dark(x + run, y)) run++;
    return run;
  };

  const sample = (x: number, y: number, size: number, module: number) => {
    const scale = 4;
    const quiet = 4;
    const side = (size + quiet * 2) * scale;
    const clean = new Uint8ClampedArray(side * side).fill(255);
    for (let row = 0; row < size; row++)
      for (let column = 0; column < size; column++) {
        if (!dark(Math.floor(x + (column + 0.5) * module), Math.floor(y + (row + 0.5) * module)))
          continue;
        for (let dy = 0; dy < scale; dy++) {
          const offset = ((row + quiet) * scale + dy) * side + (column + quiet) * scale;
          clean.fill(0, offset, offset + scale);
        }
      }
    try {
      return readQr(clean, side, side, true);
    } catch {
      // Not a complete code (for example cut off by the screen edge); try the next candidate.
      return undefined;
    }
  };

  const tried = new Set<string>();
  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width; x++) {
      if (!dark(x, y) || dark(x - 1, y) || dark(x, y - 1)) continue;
      const run = runFrom(x, y);
      if (run < 14) {
        x += run;
        continue;
      }
      // Scaled rendering makes module widths alternate between two integers, so the run gives
      // only an estimate; the exact module size comes from the code's full width.
      const estimate = run / 7;
      // The top-right finder shares this row: a run of similar length whose last column stays
      // dark for seven modules straight down. Each such run is a candidate right edge.
      for (let start = x + run + 1; start < width; start++) {
        if (!dark(start, y) || dark(start - 1, y)) continue;
        const other = runFrom(start, y);
        const right = start + other;
        start = right;
        if (Math.abs(other - run) > 3) continue;
        let edge = true;
        for (let dy = 0; dy < run && edge; dy++) edge = dark(right - 1, y + dy);
        // The width over the finder estimate drifts by several modules on large codes, so the
        // exact size is read from the timing pattern: row 6 alternates one module at a time
        // between the two top finders, and every alternation there is one module.
        const timingY = Math.floor(y + 6.5 * estimate);
        let modules = 0;
        let previous: boolean | undefined;
        for (let tx = x + run; tx < right - run; tx++) {
          const value = dark(tx, timingY);
          if (value !== previous) modules++;
          previous = value;
        }
        const timed = modules + 14;
        const size =
          timed % 4 === 1 ? timed : Math.round(((right - x) / estimate - 1) / 4) * 4 + 1;
        const module = (right - x) / size;
        const key = `${x}:${y}:${size}`;
        if (!edge || size < 21 || tried.has(key) || y + size * module > height) continue;
        tried.add(key);
        const text = sample(x, y, size, module);
        if (text !== undefined) return text;
      }
      x += run;
    }
  }
  return undefined;
}

/** Decodes a QR code in a PNG (for example a device screenshot); the topmost complete one wins. */
export function decodeQrPng(image: Buffer): string {
  const png = PNG.sync.read(image);
  const luminance = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < luminance.length; i++) {
    const o = i * 4;
    const [r = 0, g = 0, b = 0] = png.data.subarray(o, o + 3);
    luminance[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  // Grid first: on a screen showing several codes the standard reader may return any of them,
  // while the grid scan deterministically returns the topmost complete one.
  const sampled = decodeScreenshotGrid(luminance, png.width, png.height);
  if (sampled !== undefined) return sampled;
  return readQr(luminance, png.width, png.height, false);
}

async function readInput(input: string): Promise<string> {
  if (input.startsWith("obqr1:") || input.startsWith("{")) return input.trim();
  return decodeQrPng(await readFile(input));
}

async function loadWallet(options: AttendeeSignerOptions): Promise<WalletFile> {
  try {
    const wallet = parse<WalletFile>(await readFile(options.walletPath, "utf8"));
    if (wallet.schemaVersion !== 1 || wallet.runId !== options.runId)
      throw new Error("Attendee wallet file belongs to another channel");
    return wallet;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // First use: bind the wallet to the channel exactly as finalized onchain, never to local inputs.
  const client = createPublicClient({ transport: http(options.rpcUrl) });
  const signer = channelSignerFor(options.runId);
  const channelId = keccak256(stringToHex(`channel:${options.runId}`));
  const [chainId, config, channelState] = await Promise.all([
    client.getChainId(),
    client.readContract({
      address: options.vault,
      abi: vaultAbi,
      functionName: "channelConfig",
      args: [channelId],
    }),
    client.readContract({
      address: options.vault,
      abi: vaultAbi,
      functionName: "channelState",
      args: [channelId],
    }),
  ]);
  const [originalAccount, spentGross, nextSequence, , reclaimed] = channelState;
  if (
    config.channelId !== channelId ||
    originalAccount === "0x0000000000000000000000000000000000000000"
  )
    throw new Error("Reserve channel is not open onchain");
  // Vouchers settled before this wallet existed would fork the local digest chain.
  if (reclaimed || spentGross !== 0n || nextSequence !== 1)
    throw new Error("Reserve channel already has settled vouchers or was reclaimed");
  const [terminal, symbol, decimals] = await Promise.all([
    client.readContract({
      address: options.registry,
      abi: registryAbi,
      functionName: "terminals",
      args: [config.terminalInstanceId, config.terminalKeyVersion],
    }),
    client.readContract({ address: config.asset, abi: tokenAbi, functionName: "symbol" }),
    client.readContract({ address: config.asset, abi: tokenAbi, functionName: "decimals" }),
  ]);
  const state = createAttendeeChannelState({
    keyId: `channel-signer:${options.runId}`,
    signer: signer.address,
    chainId: BigInt(chainId),
    vault: options.vault,
    terminalSigner: terminal[1],
    config: config as ReserveChannelConfig,
    display: { vendorName: options.vendorName, assetSymbol: symbol, assetDecimals: decimals },
  });
  return { schemaVersion: 1, runId: options.runId, state, authorizations: [] };
}

export async function runAttendeeSigner(
  options: AttendeeSignerOptions,
): Promise<AttendeeSignerResult> {
  const wallet = await loadWallet(options);
  const payload = await readInput(options.input);
  const persist = () => writeFile(options.walletPath, json(wallet), { mode: 0o600 });

  if (payload.startsWith("{")) {
    const receipt = decodeVoucherReceipt(payload);
    const authorization = wallet.authorizations.find(
      (item) => item.paymentId === receipt.paymentId,
    );
    if (!authorization) throw new Error("Terminal receipt does not match a local authorization");
    if (authorization.supersededBy)
      throw new Error("This approval expired and was replaced; its receipt cannot be stored");
    if (authorization.receipt) {
      if (canonicalVoucherReceipt(authorization.receipt) !== payload)
        throw new Error("A different terminal receipt is already stored for this payment");
    } else {
      await verifyTerminalReceiptForAuthorization({
        state: wallet.state,
        request: authorization.request,
        attendeeSignature: authorization.attendeeSignature,
        receipt,
      });
      authorization.receipt = receipt;
      await persist();
    }
    return {
      kind: "attendee-receipt-stored",
      paymentId: receipt.paymentId,
      sequence: receipt.sequence,
    };
  }

  const request = decodePaymentRequestQr(payload);
  let authorization = wallet.authorizations.find((item) => item.paymentId === request.paymentId);
  if (authorization && authorization.requestHash !== paymentRequestHash(request))
    throw new Error("Payment identifier was already authorized for another request");
  if (!authorization) {
    const tip = wallet.authorizations.find(
      (item) => !item.supersededBy && item.request.sequence === wallet.state.nextSequence - 1,
    );
    const prepared = prepareAttendeeAuthorization({
      state: wallet.state,
      request,
      nowSeconds: options.nowSeconds ?? Math.floor(Date.now() / 1_000),
      paymentAlreadyAuthorized: false,
      tip,
    });
    const signer = channelSignerFor(options.runId);
    const attendeeSignature = await signer.sign({ hash: prepared.voucherDigest });
    const recovered = await recoverAddress({
      hash: prepared.voucherDigest,
      signature: attendeeSignature,
    });
    if (getAddress(recovered) !== wallet.state.signer)
      throw new Error("Channel key does not match the channel's attendee signer");
    authorization = {
      paymentId: request.paymentId,
      request,
      requestHash: prepared.requestHash,
      attendeeSignature,
      responseQr: encodeAttendeeResponseQr({
        version: 1,
        kind: "offline-voucher-response",
        requestHash: prepared.requestHash,
        attendeeSignature,
      }),
      receipt: null,
    };
    // Persisted before the response leaves this process, so a crash can never re-sign the sequence.
    if (prepared.supersededPaymentId && tip) tip.supersededBy = request.paymentId;
    wallet.state = prepared.nextState;
    wallet.authorizations.push(authorization);
    await persist();
  }
  await QRCode.toFile(options.responsePngPath, authorization.responseQr, {
    errorCorrectionLevel: "M",
    margin: 4,
    width: 720,
  });
  const voucher = decodeOfflineVoucher(authorization.request.voucher);
  return {
    kind: "attendee-authorized",
    paymentId: authorization.paymentId,
    sequence: authorization.request.sequence,
    grossUnits: voucher.grossUnits.toString(),
    cumulativeGrossUnits: voucher.cumulativeGrossUnits.toString(),
    remainingUnits: (wallet.state.reserveUnits - wallet.state.spentUnits).toString(),
    responsePngPath: options.responsePngPath,
    responseQr: authorization.responseQr,
  };
}
