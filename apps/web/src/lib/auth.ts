/**
 * Token-based authentication utilities.
 *
 * Uses the Web Crypto API (crypto.subtle) so it runs in the Edge runtime
 * (middleware) as well as the Node runtime (route handlers).
 *
 * Tokens are signed with HMAC-SHA256 keyed by ADMIN_PASSWORD and never
 * contain the password itself. Token format:
 *   version:timestamp:random:signature
 */

import type { NextRequest } from "next/server";

const TOKEN_VERSION = "v1";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const CLOCK_SKEW_SECONDS = 60; // tolerate minor clock skew on future-dated tokens

/**
 * Convert string to an ArrayBuffer-backed Uint8Array (BufferSource-compatible
 * for crypto.subtle).
 */
function stringToBytes(str: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(str));
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
 * Constant-time comparison of two strings to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Compute an HMAC-SHA256 signature (hex) over `payload` keyed by `secret`.
 */
async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    stringToBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, stringToBytes(payload));
  return bufferToHex(signature);
}

/**
 * Generate a secure auth token that doesn't expose the password.
 * Token format: version:timestamp:random:signature
 */
export async function generateAuthToken(secret: string): Promise<string> {
  if (!secret) {
    throw new Error("Cannot generate an auth token without a secret");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const random = randomHex(16);
  const payload = `${TOKEN_VERSION}:${timestamp}:${random}`;
  const signature = await hmacSign(payload, secret);

  return `${payload}:${signature}`;
}

/**
 * Validate an auth token.
 * Returns true only if the signature verifies and the token is not expired.
 */
export async function validateAuthToken(token: string, secret: string): Promise<boolean> {
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
    // Reject implausibly future-dated tokens
    if (timestamp - now > CLOCK_SKEW_SECONDS) return false;

    // Recompute the HMAC signature and compare in constant time
    const payload = `${version}:${timestamp}:${random}`;
    const expectedSig = await hmacSign(payload, secret);

    return timingSafeEqual(providedSig, expectedSig);
  } catch {
    return false;
  }
}

/**
 * Verify an admin password against ADMIN_PASSWORD in constant time.
 * Returns false (fail closed) if no password is configured.
 */
export async function verifyAdminPassword(password: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !password) return false;

  // Compare HMACs of equal length so the comparison itself does not leak
  // the password length via early return.
  const [a, b] = await Promise.all([
    hmacSign(password, expected),
    hmacSign(expected, expected),
  ]);
  return timingSafeEqual(a, b);
}

/**
 * Validate the `admin-auth` cookie on an incoming request.
 *
 * Fails closed: returns false when ADMIN_PASSWORD is not configured or the
 * cookie is missing/invalid. Use this in route handlers as defense-in-depth
 * alongside the middleware gate.
 */
export async function isAuthenticatedRequest(request: NextRequest): Promise<boolean> {
  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) return false;

  const raw = request.cookies.get("admin-auth")?.value;
  if (!raw) return false;

  return validateAuthToken(decodeURIComponent(raw), secret);
}
