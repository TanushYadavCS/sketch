import { constants, createDecipheriv, createPrivateKey, privateDecrypt } from "node:crypto";

export interface CredentialEnvelope {
  version: 1;
  algorithm: "RSA-OAEP-256+A256GCM";
  keyId: string;
  encryptedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function decryptCredentialEnvelope<T>(envelope: CredentialEnvelope, privateKeyPem: string): T {
  if (envelope.version !== 1 || envelope.algorithm !== "RSA-OAEP-256+A256GCM") {
    throw new Error("Unsupported credential envelope");
  }

  const privateKey = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  const contentKey = privateDecrypt(
    {
      key: privateKey,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(envelope.encryptedKey, "base64"),
  );

  const decipher = createDecipheriv("aes-256-gcm", contentKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(plaintext) as T;
}
