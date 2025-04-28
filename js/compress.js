import * as LZString from 'https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js';

export const compressData = (data) => {
  return LZString.compressToUTF16(JSON.stringify(data));
};

export const decompressData = (compressed) => {
  return JSON.parse(LZString.decompressFromUTF16(compressed));
};

const key = crypto.randomUUID();

export const encryptData = async (plainText) => {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyMaterial, enc.encode(plainText));
  return { encrypted, iv, key };
};

export const decryptData = async ({ encrypted, iv, key }) => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'AES-GCM' }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyMaterial, encrypted);
  return dec.decode(decrypted);
};