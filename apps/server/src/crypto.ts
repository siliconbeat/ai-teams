import crypto from "node:crypto";
import { type EncryptedEnvelope, isEncryptedEnvelope, parseEncryptionKey } from "@ai-teams/shared";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export type MaybeEncryptor = {
  encrypt(plainText: string): string;
  decrypt(raw: string): string;
};

export function createEncryptor(encryptionKeyHex: string | undefined): MaybeEncryptor {
  if (!encryptionKeyHex) {
    return {
      encrypt(plainText: string) {
        return plainText;
      },
      decrypt(raw: string) {
        return raw;
      },
    };
  }

  const key = parseEncryptionKey(encryptionKeyHex);

  return {
    encrypt(plainText: string): string {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
      const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const envelope: EncryptedEnvelope = {
        encrypted: true,
        iv: iv.toString("base64"),
        ciphertext: encrypted.toString("base64"),
        tag: tag.toString("base64"),
      };
      return JSON.stringify(envelope);
    },
    decrypt(raw: string): string {
      const parsed = JSON.parse(raw) as unknown;
      if (!isEncryptedEnvelope(parsed)) {
        return raw;
      }
      const iv = Buffer.from(parsed.iv, "base64");
      const ciphertext = Buffer.from(parsed.ciphertext, "base64");
      const tag = Buffer.from(parsed.tag, "base64");
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
      decipher.setAuthTag(tag);
      return decipher.update(ciphertext) + decipher.final("utf8");
    },
  };
}
