import { decrypt, encrypt } from "./encryption";

export function encodeSecretField(value: string, encryptionKey?: string): string {
  return encryptionKey ? encrypt(value, encryptionKey) : value;
}

export function decodeSecretField(value: string, encryptionKey: string | undefined, fieldName: string): string {
  if (!value.startsWith("enc:")) return value;
  if (!encryptionKey) {
    throw new Error(`Encrypted value found for ${fieldName} but ENCRYPTION_KEY is not set`);
  }
  return decrypt(value, encryptionKey);
}
