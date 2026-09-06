import crypto from "crypto";

const ENCRYPTED_PREFIX = "enc:v1";

function getEncryptionKey() {
  const rawKey = String(
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY || ""
  ).trim();

  if (!rawKey) {
    throw new Error(
      "INTEGRATION_TOKEN_ENCRYPTION_KEY is not configured"
    );
  }

  const key = Buffer.from(rawKey, "base64");

  if (key.length !== 32) {
    throw new Error(
      "INTEGRATION_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes"
    );
  }

  return key;
}

export function isEncryptedToken(value) {
  return (
    typeof value === "string" &&
    value.startsWith(`${ENCRYPTED_PREFIX}:`)
  );
}

export function encryptIntegrationToken(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return value;
  }

  const token = String(value);

  if (isEncryptedToken(token)) {
    return token;
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTED_PREFIX,
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decryptIntegrationToken(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return value;
  }

  const token = String(value);

  /*
   * Existing plaintext tokens continue to work.
   * Newly saved tokens will be encrypted.
   */
  if (!isEncryptedToken(token)) {
    return token;
  }

  const parts = token.split(":");

  if (
    parts.length !== 5 ||
    parts[0] !== "enc" ||
    parts[1] !== "v1"
  ) {
    throw new Error(
      "Invalid encrypted integration token format"
    );
  }

  const iv = Buffer.from(parts[2], "base64");
  const authTag = Buffer.from(
    parts[3],
    "base64"
  );
  const encrypted = Buffer.from(
    parts[4],
    "base64"
  );

  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
