import { decodeAbiParameters, keccak256, stringToHex, zeroAddress, zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import {
  accountCommandDigest,
  encodeValidatorSignature,
  onlineSessionTermsHash,
  ownershipHash,
  sessionPaymentDigest,
  validatorCallHash,
  validatorPermissionHash,
  withdrawalHash,
} from "../src/accounts.js";

const command = {
  chainId: 10143,
  account: "0x0000000000000000000000000000000000000001" as const,
  action: "RECOVER" as const,
  terms: zeroHash,
  epoch: 1n,
  nonce: 0n,
  deadline: 1000n,
};
describe("account command domains", () => {
  it("binds every domain and authority field", () => {
    const digest = accountCommandDigest(command);
    for (const mutation of [
      { chainId: 143 },
      { account: zeroAddress },
      { action: "ROTATE" as const },
      {
        terms: ownershipHash({
          primary: { x: zeroHash, y: zeroHash },
          backup: { x: zeroHash, y: zeroHash },
          recovery: zeroAddress,
        }),
      },
      { epoch: 2n },
      { nonce: 1n },
      { deadline: 1001n },
    ])
      expect(accountCommandDigest({ ...command, ...mutation })).not.toBe(digest);
  });
  it("rejects invalid integer ranges and distinguishes exact withdrawal amounts", () => {
    expect(() => accountCommandDigest({ ...command, nonce: -1n })).toThrow();
    expect(() => accountCommandDigest({ ...command, deadline: 1n << 256n })).toThrow();
    expect(withdrawalHash(zeroAddress, command.account, 1n)).not.toBe(
      withdrawalHash(zeroAddress, command.account, 2n),
    );
  });
  it("binds validator permissions and calls to exact contract semantics", () => {
    const purpose = keccak256(stringToHex("PAYMENT_AUTHORIZATION"));
    const payload = keccak256(stringToHex("invoice:42:25-USDC"));
    expect(validatorPermissionHash(command.account, true)).not.toBe(
      validatorPermissionHash(command.account, false),
    );
    expect(validatorCallHash(command.account, purpose, payload)).not.toBe(
      validatorCallHash(zeroAddress, purpose, payload),
    );
    expect(validatorCallHash(command.account, purpose, payload)).not.toBe(
      validatorCallHash(command.account, purpose, zeroHash),
    );
  });
  it("binds online session policy and payment signatures", () => {
    const config = {
      sessionId: keccak256(stringToHex("session:attendee-device:1")),
      signer: { x: `0x${"11".repeat(32)}` as const, y: `0x${"22".repeat(32)}` as const },
      eventId: keccak256(stringToHex("event:market-2026")),
      router: "0x0000000000000000000000000000000000000101" as const,
      asset: "0x0000000000000000000000000000000000000303" as const,
      maxPerPayment: 13_000n,
      maxTotal: 20_000n,
      validAfter: 100,
      validUntil: 800,
    };
    const terms = onlineSessionTermsHash(config);
    expect(terms).toBe("0xb70e058329e6eda61d7ab51be697828426d3df8387a6db3c89e41e53775e52e3");
    expect(onlineSessionTermsHash({ ...config, maxTotal: 20_001n })).not.toBe(terms);
    expect(() => onlineSessionTermsHash({ ...config, maxTotal: 12_999n })).toThrow(
      "Invalid online session config",
    );

    const signatureDigest = sessionPaymentDigest({
      chainId: 10143,
      account: command.account,
      sessionId: config.sessionId,
      revision: 1n,
      intentDigest: keccak256(stringToHex("payment-intent")),
      accountEpoch: 1n,
    });
    expect(signatureDigest).toBe(
      "0x2ae35b3488f9ed1a20e205480d242522e3fb8f00a0d8d3059327db61193d4b29",
    );
    expect(
      sessionPaymentDigest({
        chainId: 10143,
        account: command.account,
        sessionId: config.sessionId,
        revision: 2n,
        intentDigest: keccak256(stringToHex("payment-intent")),
        accountEpoch: 1n,
      }),
    ).not.toBe(signatureDigest);
  });
  it("encodes the strict WebAuthn validator envelope", () => {
    const purpose = keccak256(stringToHex("PAYMENT_AUTHORIZATION"));
    const encoded = encodeValidatorSignature({
      purpose,
      deadline: 1000n,
      backup: false,
      auth: {
        r: `0x${"11".repeat(32)}`,
        s: `0x${"22".repeat(32)}`,
        challengeIndex: 12n,
        typeIndex: 1n,
        authenticatorData: "0x0506",
        clientDataJSON: '{"type":"webauthn.get"}',
      },
    });
    const [decodedPurpose, deadline, backup, auth] = decodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bool" },
        {
          type: "tuple",
          components: [
            { name: "r", type: "bytes32" },
            { name: "s", type: "bytes32" },
            { name: "challengeIndex", type: "uint256" },
            { name: "typeIndex", type: "uint256" },
            { name: "authenticatorData", type: "bytes" },
            { name: "clientDataJSON", type: "string" },
          ],
        },
      ],
      encoded,
    );
    expect({ decodedPurpose, deadline, backup, auth }).toMatchObject({
      decodedPurpose: purpose,
      deadline: 1000n,
      backup: false,
      auth: { challengeIndex: 12n, typeIndex: 1n, authenticatorData: "0x0506" },
    });
    expect(() =>
      encodeValidatorSignature({
        purpose: zeroHash,
        deadline: 1000n,
        backup: false,
        auth,
      }),
    ).toThrow("Invalid validator purpose");
  });
});
