/**
 * Ambient module shim so typecheck can import the CI CLI verifier (.mjs).
 * Runtime behavior is defined in scripts/verify-production-compose.mjs.
 */
declare module '*verify-production-compose.mjs' {
  export function verifyProductionCompose(model: unknown): {
    ok: boolean;
    errors: string[];
  };
  export function isImmutableLookingImage(image: string): boolean;
}

declare module '../../scripts/verify-production-compose.mjs' {
  export function verifyProductionCompose(model: unknown): {
    ok: boolean;
    errors: string[];
  };
  export function isImmutableLookingImage(image: string): boolean;
}
