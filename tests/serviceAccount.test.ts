import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";

const envState: Record<string, unknown> = { GOOGLE_SERVICE_ACCOUNT_JSON: undefined };
vi.mock("../src/config/env.js", () => ({ env: envState }));

const { parseServiceAccountKey, buildAssertion, isServiceAccountConfigured, serviceAccountEmail, ServiceAccountError } =
  await import("../src/modules/oauth/serviceAccount.js");

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const keyFile = JSON.stringify({ client_email: "bot@proj.iam.gserviceaccount.com", private_key: privateKey });

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  envState.GOOGLE_SERVICE_ACCOUNT_JSON = undefined;
});

describe("parseServiceAccountKey", () => {
  it("reads a normal key file", () => {
    const key = parseServiceAccountKey(keyFile);
    expect(key.client_email).toBe("bot@proj.iam.gserviceaccount.com");
    expect(key.private_key).toContain("BEGIN PRIVATE KEY");
  });

  it("repairs a key whose newlines arrived escaped", () => {
    // Pasting through something that escapes newlines is common, and signing
    // then fails with an error that names none of this.
    const mangled = JSON.stringify({
      client_email: "bot@proj.iam.gserviceaccount.com",
      private_key: privateKey.replace(/\n/g, "\\n"),
    });
    expect(parseServiceAccountKey(mangled).private_key).toContain("\n");
    expect(parseServiceAccountKey(mangled).private_key).not.toContain("\\n");
  });

  it("says what is wrong when the paste isn't JSON", () => {
    expect(() => parseServiceAccountKey("not json at all")).toThrow(ServiceAccountError);
    expect(() => parseServiceAccountKey("not json at all")).toThrow(/valid JSON/i);
  });

  it("says what is missing when the file is incomplete", () => {
    expect(() => parseServiceAccountKey('{"client_email":"a@b.com"}')).toThrow(/private_key/);
  });
});

describe("buildAssertion", () => {
  it("signs a JWT Google can verify with the matching public key", () => {
    const assertion = buildAssertion(parseServiceAccountKey(keyFile), 1_700_000_000);
    const [header, claims, signature] = assertion.split(".");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    const valid = verifier.verify(
      publicKey,
      Buffer.from(signature!.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    );
    expect(valid).toBe(true);
  });

  it("claims read access to Drive and nothing else", () => {
    const assertion = buildAssertion(parseServiceAccountKey(keyFile), 1_700_000_000);
    const claims = decodeSegment(assertion.split(".")[1]!);

    expect(claims.scope).toBe("https://www.googleapis.com/auth/drive.readonly");
    expect(claims.iss).toBe("bot@proj.iam.gserviceaccount.com");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
  });

  it("expires the assertion an hour after it is issued", () => {
    const claims = decodeSegment(buildAssertion(parseServiceAccountKey(keyFile), 1_700_000_000).split(".")[1]!);
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_003_600);
  });
});

describe("configuration", () => {
  it("is off until a key is set", () => {
    expect(isServiceAccountConfigured()).toBe(false);
    expect(serviceAccountEmail()).toBeNull();
  });

  it("exposes the address to share the folder with", () => {
    envState.GOOGLE_SERVICE_ACCOUNT_JSON = keyFile;
    expect(isServiceAccountConfigured()).toBe(true);
    expect(serviceAccountEmail()).toBe("bot@proj.iam.gserviceaccount.com");
  });

  it("returns no address rather than throwing when the key is unreadable", () => {
    // Called while rendering a Telegram reply — it must not take the reply down.
    envState.GOOGLE_SERVICE_ACCOUNT_JSON = "{ broken";
    expect(serviceAccountEmail()).toBeNull();
  });
});
