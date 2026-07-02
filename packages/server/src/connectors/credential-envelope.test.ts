import { constants, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type CredentialEnvelope, decryptCredentialEnvelope } from "./credential-envelope";

function encryptForTest(payload: unknown, publicKeyPem: string): CredentialEnvelope {
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  const encryptedKey = publicEncrypt(
    {
      key: publicKeyPem,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    contentKey,
  );
  return {
    version: 1,
    algorithm: "RSA-OAEP-256+A256GCM",
    keyId: "key-1",
    encryptedKey: encryptedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

describe("decryptCredentialEnvelope", () => {
  it("decrypts a Canvas credential envelope", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const envelope = encryptForTest({ apiKey: "static-secret" }, publicKeyPem);

    expect(decryptCredentialEnvelope(envelope, privateKeyPem)).toEqual({ apiKey: "static-secret" });
  });
});
