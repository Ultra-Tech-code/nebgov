import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

/**
 * Encode an array of native JavaScript values into XDR calldata bytes suitable
 * for use in governance proposals and contract invocations.
 *
 * Each value is converted to a ScVal using nativeToScVal and then serialized
 * into a contiguous Bytes buffer.
 *
 * @example
 * ```ts
 * const calldata = encodeCalldata([
 *   "GABC...",                    // address
 *   1000n,                        // i128 amount
 *   Buffer.from("0102", "hex"),   // bytes
 * ]);
 * ```
 *
 * @param args - Array of native values to encode (strings, numbers, bigints,
 *               booleans, arrays, buffers, or hex strings starting with "0x")
 * @returns A Buffer containing the XDR-encoded calldata
 */
export function encodeCalldata(args: unknown[]): Buffer {
  const scVals = args.map((arg) => {
    if (typeof arg === "string" && arg.startsWith("0x")) {
      const hex = arg.slice(2);
      const bytes = Buffer.from(hex, "hex");
      return nativeToScVal(bytes, { type: "bytes" });
    }
    return nativeToScVal(arg);
  });
  const vec = xdr.ScVal.scvVec(scVals);
  return Buffer.from(vec.toXDR());
}

/**
 * Decode XDR calldata bytes back into native JavaScript values.
 *
 * This is useful for inspecting calldata received from events or when
 * building integrations that need to read encoded function arguments.
 *
 * @example
 * ```ts
 * const values = decodeCalldata(calldataBuffer);
 * // values is an array of decoded native JS values
 * ```
 *
 * @param data - Buffer or Uint8Array containing XDR-encoded ScVal vector
 * @returns Array of decoded native JavaScript values
 */
export function decodeCalldata(data: Buffer | Uint8Array): unknown[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const scVal = xdr.ScVal.fromXDR(buf);
  const decoded = scValToNative(scVal);
  if (!Array.isArray(decoded)) {
    throw new Error("Expected calldata to decode to an array");
  }
  return decoded;
}

/**
 * Computes the effective vote weight under quadratic voting.
 *
 * Under VoteType::Quadratic the governor uses floor(sqrt(rawBalance)) as the
 * weight, so a holder with 10,000 tokens has a weight of 100, not 10,000.
 */
export function computeQuadraticWeight(rawBalance: bigint): bigint {
  if (rawBalance < 0n) {
    throw new Error("rawBalance must be non-negative");
  }
  return BigInt(Math.floor(Math.sqrt(Number(rawBalance))));
}

/**
 * Robust hex-to-32-byte-buffer conversion utility for Soroban SDK.
 *
 * This handles stripping '0x' prefixes, padding, and validation
 * to ensure we pass correctly sized BytesN<32> equivalents to the contract.
 *
 * @param hex - Hexadecimal string (optionally prefixed with 0x)
 * @returns Uint8Array of exactly 32 bytes
 * @throws Error if hex is invalid or results in wrong byte length
 */
export function hexToBytes32(hex: string): Uint8Array {
    // Strip 0x if present
    let clean = hex.startsWith("0x") ? hex.substring(2) : hex;

    if (clean.length !== 64) {
        throw new Error(`Invalid hex length for BytesN<32>: expected 64 chars, got ${clean.length}`);
    }

    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        const byte = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        if (isNaN(byte)) {
            throw new Error(`Invalid hex character at position ${i * 2}`);
        }
        bytes[i] = byte;
    }
    return bytes;
}

/**
 * Executes a function with exponential backoff retry logic.
 *
 * @param fn - The async function to execute
 * @param opts - Retry configuration
 * @returns The result of the function call
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    retryOn?: (e: unknown) => boolean;
    onRetry?: (attempt: number, error: unknown) => void;
  }
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (opts?.retryOn && !opts.retryOn(e)) {
        throw e;
      }
      if (attempt === maxAttempts) {
        break;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      if (opts?.onRetry) {
        opts.onRetry(attempt, e);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export function isNetworkError(e: unknown): boolean {
  if (e instanceof Error) {
    const msg = e.message.toLowerCase();
    if (
      msg.includes("fetch") ||
      msg.includes("network") ||
      msg.includes("timeout") ||
      msg.includes("aborted") ||
      msg.includes("connection refused") ||
      msg.includes("econnrefused") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504")
    ) {
      return true;
    }
  }
  const status = (e as any)?.response?.status;
  if (typeof status === "number" && status >= 500 && status < 600) {
    return true;
  }
  return false;
}
