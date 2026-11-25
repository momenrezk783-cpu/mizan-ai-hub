// API key format:
//
//   mzk_<mode>_<prefix>_<secret>
//       mode   : "live" or "test"
//       prefix : 12 chars, public, stored in clear, used for lookup
//       secret : 32 chars over a 32-symbol alphabet (160 bits), never stored
//
// Only sha256(pepper || ":" || secret) is persisted. The pepper is a Worker secret, so a
// database dump on its own cannot be turned back into working keys.
//
// The plaintext is returned exactly once, at issue time. There is no recovery path: a lost
// key is revoked and replaced.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32 without i, l, o, u
const encoder = new TextEncoder();

export const KEY_PATTERN = /^mzk_(live|test)_([0-9a-z]{12})_([0-9a-z]{32})$/;

function randomChars(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  // 256 is an exact multiple of 32, so masking 5 bits introduces no modulo bias.
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return out;
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Creates a new key. The caller stores { prefix, secretHash } and returns `plaintext` to the
 * user once, then discards it.
 */
export async function issueKey({ mode, pepper }) {
  if (mode !== "live" && mode !== "test") {
    throw new TypeError(`mode must be "live" or "test", got ${JSON.stringify(mode)}`);
  }
  if (!pepper) throw new TypeError("pepper is required to issue a key");

  const prefix = randomChars(12);
  const secret = randomChars(32);

  return {
    mode,
    prefix,
    secret,
    plaintext: `mzk_${mode}_${prefix}_${secret}`,
    secretHash: await hashSecret(pepper, secret),
  };
}

/** Parses a presented key. Returns null for anything malformed; never throws. */
export function parseKey(text) {
  const match = KEY_PATTERN.exec(String(text ?? "").trim());
  if (!match) return null;
  return { mode: match[1], prefix: match[2], secret: match[3] };
}

export async function hashSecret(pepper, secret) {
  if (!pepper) throw new TypeError("pepper is required");
  return sha256Hex(`${pepper}:${secret}`);
}

/**
 * Constant-time comparison. Lengths are fixed (64 hex chars) so the early return on a length
 * mismatch reveals nothing beyond "this is not a stored hash".
 */
export function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** Verifies a presented secret against a stored hash. */
export async function verifyKey({ pepper, storedHash, secret }) {
  if (!pepper || !storedHash) return false;
  const candidate = await hashSecret(pepper, secret);
  return timingSafeEqual(candidate, storedHash);
}

/** Masks a key for display: mzk_live_ab12cd34ef56_•••• */
export function maskKey(mode, prefix) {
  return `mzk_${mode}_${prefix}_••••`;
}
