/**
 * Simple token-based authentication utilities
 * Uses HMAC-signed tokens instead of storing the password in cookies
 */

import { createHmac, randomBytes } from "crypto";

const TOKEN_VERSION = "v1";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Generate a secure auth token that doesn't expose the password
 * Token format: version:timestamp:random:signature
 */
export function generateAuthToken(secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = randomBytes(16).toString("hex");
  const payload = `${TOKEN_VERSION}:${timestamp}:${random}`;

  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex")
    .slice(0, 32); // Use first 32 chars for brevity

  return `${payload}:${signature}`;
}

/**
 * Validate an auth token
 * Returns true if valid and not expired
 */
export function validateAuthToken(token: string, secret: string): boolean {
  if (!token || !secret) return false;

  try {
    const parts = token.split(":");
    if (parts.length !== 4) return false;

    const [version, timestampStr, random, providedSig] = parts;

    // Check version
    if (version !== TOKEN_VERSION) return false;

    // Check timestamp for expiry
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) return false;

    const now = Math.floor(Date.now() / 1000);
    if (now - timestamp > TOKEN_TTL_SECONDS) return false;

    // Verify signature
    const payload = `${version}:${timestamp}:${random}`;
    const expectedSig = createHmac("sha256", secret)
      .update(payload)
      .digest("hex")
      .slice(0, 32);

    // Constant-time comparison to prevent timing attacks
    if (providedSig.length !== expectedSig.length) return false;

    let mismatch = 0;
    for (let i = 0; i < providedSig.length; i++) {
      mismatch |= providedSig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
    }

    return mismatch === 0;
  } catch {
    return false;
  }
}
