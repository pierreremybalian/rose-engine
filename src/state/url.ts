// Share URLs: recipe JSON → deflate-raw → base64url, stored in the hash as `#r=<data>`. No server involved.
import type { Recipe } from './recipe';
import { parsePreset } from '../export/preset';

const HASH_KEY = 'r';

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decompressed recipes are a few KB; anything bigger than this is junk or a deflate bomb. */
const MAX_JSON_BYTES = 1 << 20;

async function pipe(bytes: Uint8Array, transform: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(transform).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error('payload too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** base64url(deflate-raw(JSON)). */
export async function encodeRecipe(recipe: Recipe): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(recipe));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

/** Reverse of encodeRecipe, validated through parsePreset. Returns null on any failure. */
export async function decodeRecipe(s: string): Promise<Recipe | null> {
  try {
    if (typeof s !== 'string' || !s.trim()) return null;
    const bytes = fromBase64Url(s.trim());
    if (!bytes.length) return null;
    const json = new TextDecoder('utf-8', { fatal: true }).decode(await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_JSON_BYTES));
    return parsePreset(json);
  } catch {
    return null;
  }
}

function hashParam(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of h.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === HASH_KEY) return part.slice(eq + 1);
  }
  return null;
}

/** Reads `#r=...` from location.hash. Null when absent or invalid. */
export async function readRecipeFromHash(): Promise<Recipe | null> {
  if (typeof location === 'undefined') return null;
  const data = hashParam(location.hash);
  if (!data) return null;
  let raw = data;
  try {
    raw = decodeURIComponent(data);
  } catch {
    /* keep raw */
  }
  return decodeRecipe(raw);
}

/** Replaces the current history entry's hash with `#r=<data>` (no new history entry, no hashchange scroll). */
export async function writeRecipeToHash(recipe: Recipe): Promise<void> {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const data = await encodeRecipe(recipe);
  const url = `${location.pathname}${location.search}#${HASH_KEY}=${data}`;
  history.replaceState(history.state, '', url);
}
