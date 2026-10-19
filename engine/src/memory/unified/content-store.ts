/**
 * Content store: append-only file-backed content storage (from EXP418).
 *
 * Stores entry content on disk (append-only) with offsets + lengths in
 * RAM. Eliminates ~800MB of per-string V8 overhead at 1M entries (1M ×
 * 800 chars × 1 byte/char Latin1 + ~20 bytes/string overhead).
 *
 * RAM cost: 8 bytes per entry (4-byte offset + 4-byte length) + a small
 * write buffer. For 1M entries: ~8MB RAM, ~800MB on disk.
 *
 * `get` reads content on demand via `fs.readSync` — only called for
 * top-K retrieve results (typically 10 × 800 bytes = 8KB per query).
 */
import { closeSync, existsSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { InputError } from "../../kernel/errors.ts";
import { bestEffort } from "../../shared/best-effort.ts";

const WRITE_BUFFER_BYTES = 4 * 1024 * 1024;

export class ContentStore {
  private fd: number;
  private readonly path: string;
  private offsets: Uint32Array;
  private lengths: Uint32Array;
  private fileCursor = 0;
  private nextId = 0;
  private writeBuffer: Buffer;
  private writeBufferPos = 0;
  private writeBufferFileStart = 0;

  constructor(path: string, maxEntries: number) {
    if (maxEntries < 1 || !Number.isFinite(maxEntries)) {
      throw new InputError(`ContentStore: maxEntries must be a positive finite number, got ${maxEntries}`);
    }
    this.path = path;
    if (existsSync(path)) unlinkSync(path);
    this.fd = openSync(path, "w+");
    this.offsets = new Uint32Array(maxEntries);
    this.lengths = new Uint32Array(maxEntries);
    this.writeBuffer = Buffer.allocUnsafe(WRITE_BUFFER_BYTES);
    this.writeBufferFileStart = 0;
  }

  ensureCapacity(n: number): void {
    if (n <= this.offsets.length) return;
    let cap = this.offsets.length;
    while (cap < n) cap *= 2;
    const newOffsets = new Uint32Array(cap);
    const newLengths = new Uint32Array(cap);
    newOffsets.set(this.offsets);
    newLengths.set(this.lengths);
    this.offsets = newOffsets;
    this.lengths = newLengths;
  }

  add(content: string): number {
    const bytes = Buffer.from(content, "latin1");
    const id = this.nextId;
    this.nextId += 1;
    this.ensureCapacity(id + 1);
    this.offsets[id] = this.fileCursor;
    this.lengths[id] = bytes.length;
    if (this.writeBufferPos + bytes.length > this.writeBuffer.length) {
      this.flushWriteBuffer();
    }
    bytes.copy(this.writeBuffer, this.writeBufferPos);
    this.writeBufferPos += bytes.length;
    this.fileCursor += bytes.length;
    return id;
  }

  private flushWriteBuffer(): void {
    if (this.writeBufferPos > 0) {
      writeSync(this.fd, this.writeBuffer, 0, this.writeBufferPos, this.writeBufferFileStart);
      this.writeBufferFileStart += this.writeBufferPos;
      this.writeBufferPos = 0;
    }
  }

  get(id: number): string {
    if (id >= this.nextId) throw new InputError(`ContentStore: id ${id} out of range (nextId=${this.nextId})`);
    const offset = this.offsets[id];
    const len = this.lengths[id];
    if (offset === undefined || len === undefined) {
      throw new InputError(`ContentStore: missing offset/length for id ${id}`);
    }
    const bufStart = this.writeBufferFileStart;
    if (offset >= bufStart && offset + len <= bufStart + this.writeBufferPos) {
      const bufOffset = offset - bufStart;
      return this.writeBuffer.toString("latin1", bufOffset, bufOffset + len);
    }
    const buf = Buffer.allocUnsafe(len);
    readSync(this.fd, buf, 0, len, offset);
    return buf.toString("latin1");
  }

  includes(id: number, needle: string): boolean {
    return this.get(id).includes(needle);
  }

  flush(): void {
    this.flushWriteBuffer();
  }

  get size(): number {
    return this.nextId;
  }

  /** On-disk file size in bytes (after flush). */
  get fileSize(): number {
    return this.fileCursor;
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }

  destroy(): void {
    bestEffort(() => closeSync(this.fd));
    bestEffort(() => unlinkSync(this.path));
  }
}
