import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { accountFactoryAbi } from "@openbalance/protocol";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Pool } from "pg";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  type Hex,
  http,
  keccak256,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountAccessService } from "../src/account-access.js";
import { buildApp } from "../src/app.js";
import { DeploymentChain, DeploymentMismatch } from "../src/deployment-chain.js";
import { DeploymentService } from "../src/deployments.js";
import {
  EnrollmentRejected,
  EnrollmentService,
  validateEnrollmentPolicy,
} from "../src/enrollment.js";
import {
  DeploymentSponsorshipService,
  SponsorshipConflict,
  SponsorshipQuotaExceeded,
} from "../src/sponsorship.js";

// Minimal CBOR fixture encoder; real verification and signature checking run in the service.
function cbor(value: number | string | Buffer | Map<unknown, unknown>): Buffer {
  const length = (major: number, size: number) =>
    size < 24 ? Buffer.from([major * 32 + size]) : Buffer.from([major * 32 + 24, size]);
  if (typeof value === "number") return length(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === "string")
    return Buffer.concat([length(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([length(2, value.length), value]);
  return Buffer.concat([
    length(5, value.size),
    ...[...value].flatMap(([key, item]) => [
      cbor(key as number | string),
      cbor(item as Parameters<typeof cbor>[0]),
    ]),
  ]);
}
const policy = { rpId: "localhost", origin: "http://localhost:3000" };
function fixture(challenge: string) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const key = cbor(
    new Map<unknown, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x as string, "base64url")],
      [-3, Buffer.from(jwk.y as string, "base64url")],
    ]),
  );
  const rp = createHash("sha256").update(policy.rpId).digest();
  const client = (type: string, challenge: string, origin = policy.origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const auth = Buffer.concat([
    rp,
    Buffer.from([0x45]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    Buffer.from([0, id.length]),
    id,
    key,
  ]);
  const registration: RegistrationResponseJSON = {
    id: id.toString("base64url"),
    rawId: id.toString("base64url"),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: client("webauthn.create", challenge).toString("base64url"),
      attestationObject: cbor(
        new Map<unknown, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", auth],
        ]),
      ).toString("base64url"),
    },
  };
  function proof(challenge: string, origin = policy.origin, flags = 5): AuthenticationResponseJSON {
    const data = client("webauthn.get", challenge, origin);
    const auth = Buffer.concat([rp, Buffer.from([flags]), Buffer.alloc(4)]);
    return {
      id: registration.id,
      rawId: registration.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: data.toString("base64url"),
        authenticatorData: auth.toString("base64url"),
        signature: sign(
          "sha256",
          Buffer.concat([auth, createHash("sha256").update(data).digest()]),
          keys.privateKey,
        ).toString("base64url"),
      },
    };
  }
  return {
    registration,
    proof,
    x: `0x${Buffer.from(jwk.x as string, "base64url").toString("hex")}`,
  };
}

it("rejects insecure, mismatched and noncanonical origin policies", () => {
  expect(validateEnrollmentPolicy(policy)).toEqual(policy);
  for (const origin of [
    "http://example.com",
    "https://evil.localhost.invalid",
    "http://localhost:3000/",
  ])
    expect(() => validateEnrollmentPolicy({ ...policy, origin })).toThrow();
});

describe.skipIf(!process.env.ENROLLMENT_TEST_DATABASE_URL)(
  "PostgreSQL enrollment ceremonies",
  () => {
    let pool: Pool;
    let service: EnrollmentService;
    const schema = `enrollment_test_${randomBytes(8).toString("hex")}`;
    beforeAll(async () => {
      pool = new Pool({
        connectionString: process.env.ENROLLMENT_TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
        max: 5,
      });
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        await readFile(new URL("../migrations/001_enrollment.sql", import.meta.url), "utf8"),
      );
      service = new EnrollmentService(pool, policy);
      await pool.query(
        await readFile(
          new URL("../migrations/002_account_deployments.sql", import.meta.url),
          "utf8",
        ),
      );
      await pool.query(
        await readFile(new URL("../migrations/003_account_access.sql", import.meta.url), "utf8"),
      );
      await pool.query(
        await readFile(
          new URL("../migrations/004_deployment_sponsorship.sql", import.meta.url),
          "utf8",
        ),
      );
    });
    afterAll(async () => {
      if (pool) {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
        await pool.end();
      }
    });

    it("persists across service restart, verifies key possession and rejects concurrent replay", async () => {
      const start = await service.begin();
      const f = fixture(start.options.challenge);
      const registered = await service.verify(start.token, "register", f.registration);
      if (!registered.options) throw new Error("Missing proof options");
      const restarted = new EnrollmentService(pool, policy);
      const results = await Promise.allSettled([
        restarted.verify(start.token, "prove", f.proof(registered.options.challenge)),
        service.verify(start.token, "prove", f.proof(registered.options.challenge)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const success = results.find((r) => r.status === "fulfilled");
      if (success?.status !== "fulfilled") throw new Error("Missing verified enrollment");
      expect(success.value.publicKey.x).toBe(f.x);
      await expect(service.verify(start.token, "register", f.registration)).rejects.toBeInstanceOf(
        EnrollmentRejected,
      );
    });

    it.skipIf(!process.env.DEPLOYMENT_TEST_RPC_URL)(
      "deploys verified enrollment once across retries and verifies finalized ownership",
      async () => {
        const rpc = process.env.DEPLOYMENT_TEST_RPC_URL as string;
        const client = createPublicClient({ transport: http(rpc) });
        if ((await client.getChainId()) !== 31337)
          throw new Error("Deployment tests require local Anvil");
        const wallet = createWalletClient({ transport: http(rpc) });
        const miner = createTestClient({ mode: "anvil", transport: http(rpc) });
        const [payer] = await wallet.getAddresses();
        if (!payer) throw new Error("Missing local test payer");
        const artifact = JSON.parse(
          await readFile(
            new URL(
              "../../../contracts/out/AccountFactory.sol/AccountFactory.json",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        const receipt = await client.waitForTransactionReceipt({
          hash: await wallet.deployContract({
            account: payer,
            chain: null,
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
          }),
        });
        const factory = receipt.contractAddress as Address;
        await miner.mine({ blocks: 64 });
        const implementation = await client.readContract({
          address: factory,
          abi: accountFactoryAbi,
          functionName: "implementation",
        });
        const manifest = {
          version: 1,
          chainId: 31337,
          factory,
          implementation,
          factoryCodeHash: keccak256((await client.getCode({ address: factory })) as Hex),
          implementationCodeHash: keccak256(
            (await client.getCode({ address: implementation })) as Hex,
          ),
        };
        const chain = new DeploymentChain(manifest, rpc);
        const deployments = new DeploymentService(pool, chain, policy);
        const sponsorAccount = privateKeyToAccount(generatePrivateKey());
        await miner.setBalance({ address: sponsorAccount.address, value: 10n ** 18n });
        const sponsorship = new DeploymentSponsorshipService(pool, deployments, sponsorAccount, {
          dailyDeployments: 10,
          maxGas: 2_000_000n,
          maxFeePerGas: 100_000_000_000n,
          maxCost: 100_000_000_000_000_000n,
        });
        const start = await service.begin();
        await expect(deployments.process(start.token)).rejects.toBeInstanceOf(EnrollmentRejected);
        const f = fixture(start.options.challenge);
        const registration = await service.verify(start.token, "register", f.registration);
        if (!registration.options) throw new Error("Missing proof options");
        await service.verify(start.token, "prove", f.proof(registration.options.challenge));
        await expect(deployments.process(start.token, true)).rejects.toBeInstanceOf(
          EnrollmentRejected,
        );
        const [first, retry] = await Promise.all([
          deployments.process(start.token),
          deployments.process(start.token),
        ]);
        expect(first).toEqual(retry);
        expect(first.status).toBe("pending");
        expect(first.parameters.owners.primary.x).toBe(f.x);
        expect(first.parameters.owners.recovery).toBe("0x0000000000000000000000000000000000000000");
        expect((await pool.query("SELECT count(*) FROM account_deployments")).rows[0].count).toBe(
          "1",
        );
        const hash = await wallet.sendTransaction({
          account: payer,
          chain: null,
          to: first.transaction.to,
          data: first.transaction.data,
          value: 0n,
        });
        await client.waitForTransactionReceipt({ hash });
        expect((await deployments.process(start.token, true)).status).toBe("pending");
        await miner.mine({ blocks: 64 });
        const restarted = new DeploymentService(pool, new DeploymentChain(manifest, rpc), policy);
        const confirmed = await restarted.process(start.token, true);
        expect(confirmed.status).toBe("confirmed");
        expect(confirmed.account).toBe(first.account);
        expect((await restarted.process(start.token)).status).toBe("confirmed");
        const access = new AccountAccessService(pool, policy, 1);
        const authentication = await access.begin(confirmed.account);
        const assertion = f.proof(authentication.options.challenge);
        const attempts = await Promise.allSettled([
          access.verify(authentication.challengeToken, assertion),
          access.verify(authentication.challengeToken, assertion),
        ]);
        const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
        expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
        if (accepted?.status !== "fulfilled") throw new Error("Missing account session");
        expect(accepted.value.account).toBe(confirmed.account);
        expect(await access.me(`Bearer ${accepted.value.sessionToken}`)).toEqual({
          account: confirmed.account,
        });
        const authenticatedApp = await buildApp(service, policy.origin, restarted, access);
        const me = await authenticatedApp.inject({
          method: "GET",
          url: "/v1/accounts/me",
          headers: { authorization: `Bearer ${accepted.value.sessionToken}` },
        });
        expect(me.statusCode).toBe(200);
        expect(me.headers["cache-control"]).toBe("no-store");
        const revoked = await authenticatedApp.inject({
          method: "POST",
          url: "/v1/accounts/sessions/revoke",
          headers: {
            authorization: `Bearer ${accepted.value.sessionToken}`,
            origin: policy.origin,
          },
          payload: {},
        });
        expect(revoked.statusCode).toBe(200);
        expect(
          (
            await authenticatedApp.inject({
              method: "GET",
              url: "/v1/accounts/me",
              headers: { authorization: `Bearer ${accepted.value.sessionToken}` },
            })
          ).statusCode,
        ).toBe(401);
        await authenticatedApp.close();

        const sponsoredStart = await service.begin();
        const sponsoredFixture = fixture(sponsoredStart.options.challenge);
        const sponsoredRegistration = await service.verify(
          sponsoredStart.token,
          "register",
          sponsoredFixture.registration,
        );
        if (!sponsoredRegistration.options) throw new Error("Missing sponsored proof options");
        await service.verify(
          sponsoredStart.token,
          "prove",
          sponsoredFixture.proof(sponsoredRegistration.options.challenge),
        );
        const idempotencyKey = `deployment:${randomBytes(16).toString("hex")}`;
        const sponsored = await Promise.all([
          sponsorship.process(sponsoredStart.token, idempotencyKey),
          sponsorship.process(sponsoredStart.token, idempotencyKey),
        ]);
        expect(sponsored.every((result) => result.status === "submitted")).toBe(true);
        const [firstSponsored, secondSponsored] = sponsored;
        if (firstSponsored?.status !== "submitted" || secondSponsored?.status !== "submitted")
          throw new Error("Sponsored deployment did not submit");
        expect(firstSponsored.transactionHash).toBe(secondSponsored.transactionHash);
        expect(
          (await pool.query("SELECT count(*) FROM deployment_sponsorships")).rows[0].count,
        ).toBe("1");
        await expect(
          sponsorship.process(sponsoredStart.token, `${idempotencyKey}:changed`),
        ).rejects.toBeInstanceOf(SponsorshipConflict);
        await miner.mine({ blocks: 64 });
        expect((await sponsorship.process(sponsoredStart.token, idempotencyKey)).status).toBe(
          "confirmed",
        );
        expect(await sponsorship.reconcilePending()).toEqual({
          inspected: 0,
          confirmed: 0,
          pending: 0,
          failed: 0,
        });
        const quotaStart = await service.begin();
        const quotaFixture = fixture(quotaStart.options.challenge);
        const quotaRegistration = await service.verify(
          quotaStart.token,
          "register",
          quotaFixture.registration,
        );
        if (!quotaRegistration.options) throw new Error("Missing quota proof options");
        await service.verify(
          quotaStart.token,
          "prove",
          quotaFixture.proof(quotaRegistration.options.challenge),
        );
        const limited = new DeploymentSponsorshipService(pool, deployments, sponsorAccount, {
          dailyDeployments: 1,
          maxGas: 2_000_000n,
          maxFeePerGas: 100_000_000_000n,
          maxCost: 100_000_000_000_000_000n,
        });
        await expect(
          limited.process(quotaStart.token, `deployment:${randomBytes(16).toString("hex")}`),
        ).rejects.toBeInstanceOf(SponsorshipQuotaExceeded);
        await expect(
          restarted.process(randomBytes(32).toString("base64url")),
        ).rejects.toBeInstanceOf(EnrollmentRejected);
        const wrongChain = new DeploymentChain({ ...manifest, chainId: 10143 }, rpc);
        await expect(wrongChain.checkpoint()).rejects.toBeInstanceOf(DeploymentMismatch);
        const wrongCode = new DeploymentChain(
          { ...manifest, factoryCodeHash: `0x${"11".repeat(32)}` },
          rpc,
        );
        await expect(wrongCode.checkpoint()).rejects.toBeInstanceOf(DeploymentMismatch);
        await expect(
          new DeploymentService(pool, wrongCode, policy).process(start.token),
        ).rejects.toBeInstanceOf(DeploymentMismatch);
        const app = await buildApp(service, policy.origin, restarted);
        const tampered = await app.inject({
          method: "POST",
          url: "/v1/accounts/deployments/prepare",
          headers: { origin: policy.origin },
          payload: { token: start.token, primary: f.x },
        });
        expect(tampered.statusCode).toBe(400);
        const verified = await app.inject({
          method: "POST",
          url: "/v1/accounts/deployments/confirm",
          headers: { origin: policy.origin },
          payload: { token: start.token },
        });
        expect(verified.statusCode).toBe(200);
        expect(verified.json().status).toBe("confirmed");
        await app.close();
      },
    );

    it("rejects wrong challenge, origin, missing verification and forged signatures without advancing state", async () => {
      const start = await service.begin();
      const f = fixture(start.options.challenge);
      const registered = await service.verify(start.token, "register", f.registration);
      if (!registered.options) throw new Error("Missing proof options");
      const challenge = registered.options.challenge;
      const forged = f.proof(challenge);
      forged.response.signature = randomBytes(70).toString("base64url");
      for (const proof of [
        f.proof("wrong"),
        f.proof(challenge, "https://evil.invalid"),
        f.proof(challenge, policy.origin, 1),
        f.proof(challenge, policy.origin, 0x15),
        forged,
      ])
        await expect(service.verify(start.token, "prove", proof)).rejects.toBeInstanceOf(
          EnrollmentRejected,
        );
      expect((await service.verify(start.token, "prove", f.proof(challenge))).status).toBe(
        "verified",
      );
    });

    it("rejects expired and foreign tokens and cross-origin API calls", async () => {
      const start = await service.begin();
      const f = fixture(start.options.challenge);
      await pool.query(
        "UPDATE account_enrollments SET expires_at=now()-interval '1 second' WHERE challenge=$1",
        [start.options.challenge],
      );
      await expect(service.verify(start.token, "register", f.registration)).rejects.toBeInstanceOf(
        EnrollmentRejected,
      );
      await expect(
        service.verify(randomBytes(32).toString("base64url"), "register", f.registration),
      ).rejects.toBeInstanceOf(EnrollmentRejected);
      const app = await buildApp(service, policy.origin);
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/accounts/enrollment-challenges",
        headers: { origin: "https://evil.invalid" },
        payload: {},
      });
      expect(rejected.statusCode).toBe(403);
      const allowed = await app.inject({
        method: "POST",
        url: "/v1/accounts/enrollment-challenges",
        headers: { origin: policy.origin },
        payload: {},
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers["cache-control"]).toBe("no-store");
      await app.close();
    });
  },
);
