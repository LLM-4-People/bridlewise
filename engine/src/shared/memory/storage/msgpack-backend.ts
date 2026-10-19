// src/shared/memory/storage/msgpack-backend.ts
// MessagePack storage (pure-TS minimal encoder/decoder, no dep). MessagePack
// is a compact binary format (~30% smaller than JSON per Kagi research).
// This is a minimal, correct encoder for the wire record shape (no floats
// beyond Float32Array, no bigints, no ext types) — sufficient for the
// benchmark and avoids a runtime dependency (binding directive: minimal
// deps). The format spec: https://github.com/msgpack/msgpack/blob/master/spec.md

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import type { MemoryEntry } from "../memory-entry.ts";
import type { BackendStorageOptions, MemoryStoragePort } from "./backend.ts";
import { fromWire, safeFromWire, toWire, type WireRecord } from "./serde.ts";
import { InputError } from "../../../kernel/errors.ts";

// --- Minimal MessagePack encoder (single owner; no dep) -----------------

function encodeMsgpack(value: unknown): Buffer {
  const parts: Buffer[] = [];
  enc(value, parts);
  return Buffer.concat(parts);
}

function enc(v: unknown, out: Buffer[]): void {
  if (v === null) { out.push(Buffer.from([0xc0])); return; }
  if (v === undefined) { out.push(Buffer.from([0xc0])); return; }
  if (typeof v === "boolean") { out.push(Buffer.from([v ? 0xc3 : 0xc2])); return; }
  if (typeof v === "number") { encNum(v, out); return; }
  if (typeof v === "string") { encStr(v, out); return; }
  if (v instanceof Array) { encArr(v as unknown[], out); return; }
  if (typeof v === "object") { encObj(v as Record<string, unknown>, out); return; }
  out.push(Buffer.from([0xc0])); // unknown -> null
}

function encNum(n: number, out: Buffer[]): void {
  if (Number.isInteger(n)) {
    if (n >= 0 && n <= 0x7f) { out.push(Buffer.from([n])); return; }
    if (n < 0 && n >= -32) { out.push(Buffer.from([n + 0x100])); return; }
    if (n >= 0 && n <= 0xff) { out.push(Buffer.from([0xcc, n])); return; }
    if (n >= 0 && n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xcd; b.writeUInt16BE(n, 1); out.push(b); return; }
    if (n >= 0 && n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(n >>> 0, 1); out.push(b); return; }
    if (n < 0 && n >= -0x8000) { const b = Buffer.alloc(3); b[0] = 0xd1; b.writeInt16BE(n, 1); out.push(b); return; }
    if (n < 0 && n >= -0x80000000) { const b = Buffer.alloc(5); b[0] = 0xd2; b.writeInt32BE(n, 1); out.push(b); return; }
  }
  // float64 (double)
  const b = Buffer.alloc(9);
  b[0] = 0xcb;
  b.writeDoubleBE(n, 1);
  out.push(b);
}

function encStr(s: string, out: Buffer[]): void {
  const bytes = Buffer.from(s, "utf8");
  const len = bytes.length;
  if (len <= 31) { out.push(Buffer.from([0xa0 | len])); }
  else if (len <= 0xff) { const h = Buffer.alloc(2); h[0] = 0xd9; h[1] = len; out.push(h); }
  else if (len <= 0xffff) { const h = Buffer.alloc(3); h[0] = 0xda; h.writeUInt16BE(len, 1); out.push(h); }
  else { const h = Buffer.alloc(5); h[0] = 0xdb; h.writeUInt32BE(len, 1); out.push(h); }
  out.push(bytes);
}

function encArr(a: unknown[], out: Buffer[]): void {
  const len = a.length;
  if (len <= 15) { out.push(Buffer.from([0x90 | len])); }
  else if (len <= 0xffff) { const h = Buffer.alloc(3); h[0] = 0xdc; h.writeUInt16BE(len, 1); out.push(h); }
  else { const h = Buffer.alloc(5); h[0] = 0xdd; h.writeUInt32BE(len, 1); out.push(h); }
  for (const item of a) enc(item, out);
}

function encObj(o: Record<string, unknown>, out: Buffer[]): void {
  const keys = Object.keys(o);
  const len = keys.length;
  if (len <= 15) { out.push(Buffer.from([0x80 | len])); }
  else if (len <= 0xffff) { const h = Buffer.alloc(3); h[0] = 0xde; h.writeUInt16BE(len, 1); out.push(h); }
  else { const h = Buffer.alloc(5); h[0] = 0xdf; h.writeUInt32BE(len, 1); out.push(h); }
  for (const k of keys) { encStr(k, out); enc(o[k], out); }
}

// --- Minimal MessagePack decoder ----------------------------------------

function decodeMsgpack(buf: Buffer): unknown {
  const st = { pos: 0, buf };
  return dec(st);
}

function dec(st: { pos: number; buf: Buffer }): unknown {
  const b = st.buf[st.pos];
  st.pos += 1;
  if (b === undefined) throw new InputError("msgpack: truncated", "shared_memory_msgpack_truncated");
  if (b <= 0x7f) return b; // positive fixint
  if (b >= 0xe0) return b - 0x100; // negative fixint
  if (b >= 0x80 && b <= 0x8f) return decMap(st, b & 0x0f); // fixmap
  if (b >= 0x90 && b <= 0x9f) return decArr(st, b & 0x0f); // fixarray
  if (b >= 0xa0 && b <= 0xbf) return decStr(st, b & 0x1f); // fixstr
  switch (b) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xcc: { const v = st.buf[st.pos]; st.pos += 1; if (v === undefined) throw new InputError("msgpack: truncated uint8", "shared_memory_msgpack_truncated"); return v; }
    case 0xcd: { const v = st.buf.readUInt16BE(st.pos); st.pos += 2; return v; }
    case 0xce: { const v = st.buf.readUInt32BE(st.pos); st.pos += 4; return v; }
    case 0xd9: { const len = st.buf[st.pos]; st.pos += 1; if (len === undefined) throw new InputError("msgpack: truncated str8 len", "shared_memory_msgpack_truncated"); return decStr(st, len); }
    case 0xda: { const len = st.buf.readUInt16BE(st.pos); st.pos += 2; return decStr(st, len); }
    case 0xdb: { const len = st.buf.readUInt32BE(st.pos); st.pos += 4; return decStr(st, len); }
    case 0xd1: { const v = st.buf.readInt16BE(st.pos); st.pos += 2; return v; }
    case 0xd2: { const v = st.buf.readInt32BE(st.pos); st.pos += 4; return v; }
    case 0xdc: { const len = st.buf.readUInt16BE(st.pos); st.pos += 2; return decArr(st, len); }
    case 0xdd: { const len = st.buf.readUInt32BE(st.pos); st.pos += 4; return decArr(st, len); }
    case 0xde: { const len = st.buf.readUInt16BE(st.pos); st.pos += 2; return decMap(st, len); }
    case 0xdf: { const len = st.buf.readUInt32BE(st.pos); st.pos += 4; return decMap(st, len); }
    case 0xcb: { const v = st.buf.readDoubleBE(st.pos); st.pos += 8; return v; }
    default: throw new InputError(`msgpack: unsupported tag 0x${b.toString(16)}`, "shared_memory_msgpack_unsupported_tag");
  }
}

function decStr(st: { pos: number; buf: Buffer }, len: number): string {
  const s = st.buf.subarray(st.pos, st.pos + len).toString("utf8");
  st.pos += len;
  return s;
}

function decArr(st: { pos: number; buf: Buffer }, len: number): unknown[] {
  const a: unknown[] = [];
  for (let i = 0; i < len; i += 1) a.push(dec(st));
  return a;
}

function decMap(st: { pos: number; buf: Buffer }, len: number): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (let i = 0; i < len; i += 1) {
    const k = dec(st) as string;
    o[k] = dec(st);
  }
  return o;
}

// --- Storage backend -----------------------------------------------------

export function createMsgpackStorage(options: BackendStorageOptions): MemoryStoragePort {
  const { path } = options;
  let bytes = 0;
  let ops = 0;
  return {
    backend: "msgpack",
    flush(entries) {
      const wire = entries.map(toWire);
      const buf = encodeMsgpack(wire);
      writeFileSync(path, buf);
      bytes += buf.byteLength;
      ops += 1;
    },
    append(_entry) { /* snapshot-only */ },
    load() {
      if (!existsSync(path)) return [];
      const buf = readFileSync(path);
      const arr = decodeMsgpack(buf) as WireRecord[];
      const out: MemoryEntry[] = [];
      let corrupt = 0;
      for (const w of arr) {
        const e = safeFromWire(w);
        if (e) out.push(e);
        else corrupt += 1;
      }
      if (corrupt > 0) process.stderr.write(`msgpack-backend: dropped ${corrupt} corrupt entries\n`);
      return out;
    },
    bytesWritten() { return bytes; },
    opCount() { return ops; },
    close() { /* nothing to release */ },
  };
}

export { encodeMsgpack, decodeMsgpack, fromWire };
