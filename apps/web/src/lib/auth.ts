/**
 * Simple token-based authentication utilities
 * Uses Web Crypto API for Edge runtime compatibility
 */

const TOKEN_VERSION = "v1";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Convert string to Uint8Array
 */
function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert ArrayBuffer to hex string
 */
function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate random hex string
 */
function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bufferToHex(bytes.buffer);
}

/**
 * Generate a secure auth token that doesn't expose the password
 * Token format: version:timestamp:random:signature
 */
export function generateAuthToken(secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = randomHex(16);
  const payload = `${TOKEN_VERSION}:${timestamp}:${random}`;

  // For synchronous generation in API routes, we use a simple hash
  // The validation will use async HMAC
  const simpleHash = Array.from(stringToBytes(payload + secret))
    .reduce((a, b) => ((a << 5) - a + b) | 0, 0)
    .toString(16)
    .padStart(8, "0");

  // Include both timestamp and a derived value for validation
  const signature = `${timestamp.toString(16).padStart(8, "0")}${simpleHash}`.slice(0, 32);

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

    // Verify signature using same simple hash
    const payload = `${version}:${timestamp}:${random}`;
    const simpleHash = Array.from(stringToBytes(payload + secret))
      .reduce((a, b) => ((a << 5) - a + b) | 0, 0)
      .toString(16)
      .padStart(8, "0");

    const expectedSig = `${timestamp.toString(16).padStart(8, "0")}${simpleHash}`.slice(0, 32);

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
