import { InputError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";

/**
 * Transport-independent SSE framing. Input is UTF-8-decoded text; HTTP and
 * application event interpretation belong to the caller. The parser retains
 * named events and reconnect metadata, handles every standard line ending,
 * and dispatches only on a blank line, never on an unfinished transport EOF.
 */
export const SSE_DONE_SENTINEL = ROOT_POLICY.contracts.chatStreamDoneSentinel;
const MAX_EVENT_BYTES = ROOT_POLICY.runtime.limits.maximumSseEventBytes;
const MAX_LINE_BYTES = ROOT_POLICY.runtime.limits.maximumSseLineBytes;

export type SseDataEvent = Readonly<{
  type: "data";
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}>;
export type SseDoneEvent = Readonly<{ type: "done" }>;
export type SseCommentEvent = Readonly<{ type: "comment" }>;
export type SseLimits = Readonly<{ maxEventBytes?: number; maxLineBytes?: number }>;
export type SseEvent = SseDataEvent | SseDoneEvent | SseCommentEvent;

/** Parse one already-delimited event block through the same framing owner. */
export function parseSseEventBlock(
  block: string,
  doneSentinel: string | null = SSE_DONE_SENTINEL,
): SseEvent | undefined {
  const buffer = new SseBuffer(doneSentinel);
  buffer.push(`${block}\n\n`);
  return buffer.drain()[0];
}

/**
 * Bounded incremental framing. Limits apply to each UTF-8 field line (without
 * its terminator) and each event's fields including their line terminators;
 * the separating blank line is not part of the event. They never apply to a
 * network chunk, which can contain any number of independently bounded events.
 * `null` disables application-specific done-sentinel interpretation.
 */
export class SseBuffer {
  private readonly doneSentinel: string | null;
  private readonly maxEventBytes: number;
  private readonly maxLineBytes: number;
  private line = "";
  private lineBytes = 0;
  private eventBytes = 0;
  private eventLength = 0;
  private dataParts: string[] = [];
  private eventName = "";
  private lastEventId: string | undefined;
  private retry: number | undefined;
  private hasComment = false;
  private atStart = true;
  private skipLf = false;
  private precedingLineHadFields = false;
  private highSurrogate = "";
  private ready: SseEvent[] = [];
  private emitted = 0;
  private finished = false;

  constructor(
    doneSentinel: string | null = SSE_DONE_SENTINEL,
    maxEventBytes: number = MAX_EVENT_BYTES,
    maxLineBytes: number = MAX_LINE_BYTES,
  ) {
    if (![maxEventBytes, maxLineBytes].every((limit) => Number.isSafeInteger(limit) && limit > 0)) {
      throw new InputError("SSE byte limits must be positive safe integers", "sse_limits_invalid");
    }
    this.doneSentinel = doneSentinel;
    this.maxEventBytes = maxEventBytes;
    this.maxLineBytes = maxLineBytes;
  }

  push(chunk: string): void {
    if (typeof chunk !== "string") {
      throw new InputError("SSE chunks must contain decoded text", "sse_chunk_invalid");
    }
    if (chunk.length === 0 || this.finished) return;
    let text = this.highSurrogate + chunk;
    this.highSurrogate = "";
    // UTF-8 decoders do not split a scalar, but string-producing callers can
    // split a surrogate pair. Carry its first half so byte accounting remains
    // independent of the caller's chunk boundaries.
    if (/[\uD800-\uDBFF]$/u.test(text)) {
      this.highSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (text.length === 0) return;
    if (this.atStart) {
      this.atStart = false;
      if (text.startsWith("\uFEFF")) text = text.slice(1);
    }
    if (this.skipLf) {
      this.skipLf = false;
      if (text.startsWith("\n")) {
        this.countCrLfTail();
        text = text.slice(1);
      }
    }
    const lineEndings = /[\r\n]/gu;
    let offset = 0;
    for (let match = lineEndings.exec(text); match !== null; match = lineEndings.exec(text)) {
      this.appendLine(text.slice(offset, match.index));
      this.finishLine();
      if (this.finished) return;
      offset = match.index + match[0].length;
      if (match[0] === "\r") {
        if (text[offset] === "\n") {
          this.countCrLfTail();
          offset += 1;
          lineEndings.lastIndex = offset;
        } else if (offset === text.length) {
          this.skipLf = true;
        }
      }
    }
    this.appendLine(text.slice(offset));
  }

  private appendLine(fragment: string): void {
    if (fragment.length === 0) return;
    this.lineBytes += Buffer.byteLength(fragment, "utf8");
    if (this.lineBytes > this.maxLineBytes) {
      throw new InputError("SSE line exceeds maximum size", "sse_line_oversized");
    }
    this.checkEventSize(this.lineBytes);
    this.line += fragment;
  }

  private checkEventSize(additionalBytes = 0): void {
    if (this.eventBytes + additionalBytes > this.maxEventBytes) {
      throw new InputError("SSE event exceeds maximum size", "sse_event_oversized");
    }
  }

  private countCrLfTail(): void {
    if (!this.precedingLineHadFields) return;
    this.eventBytes += 1;
    this.eventLength += 1;
    this.checkEventSize();
  }

  private finishLine(): void {
    const line = this.line;
    this.line = "";
    this.precedingLineHadFields = line.length > 0;
    if (line.length === 0) {
      this.dispatch();
    } else {
      this.eventBytes += this.lineBytes + 1;
      this.eventLength += line.length + 1;
      this.checkEventSize();
      this.processField(line);
    }
    this.lineBytes = 0;
  }

  private processField(line: string): void {
    if (line.startsWith(":")) {
      this.hasComment = true;
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data": this.dataParts.push(value); break;
      case "event": this.eventName = value; break;
      case "id": if (!value.includes("\0")) this.lastEventId = value; break;
      case "retry":
        if (/^[0-9]+$/u.test(value)) {
          const milliseconds = Number(value);
          if (!Number.isSafeInteger(milliseconds)) {
            throw new InputError("SSE retry interval exceeds the representable integer range", "sse_retry_oversized");
          }
          this.retry = milliseconds;
        }
        break;
    }
  }

  private dispatch(): void {
    let event: SseEvent | undefined;
    if (this.dataParts.length > 0) {
      const data = this.dataParts.join("\n");
      event = this.doneSentinel !== null && data === this.doneSentinel
        ? { type: "done" }
        : {
          type: "data", data,
          ...(this.eventName !== "" ? { event: this.eventName } : {}),
          ...(this.lastEventId !== undefined ? { id: this.lastEventId } : {}),
          ...(this.retry !== undefined ? { retry: this.retry } : {}),
        };
    } else if (this.hasComment) {
      event = { type: "comment" };
    }
    if (event !== undefined) {
      this.ready.push(event);
      this.emitted += 1;
      this.finished = event.type === "done";
    }
    this.dataParts = [];
    this.eventName = "";
    this.hasComment = false;
    this.eventBytes = 0;
    this.eventLength = 0;
  }

  drain(): readonly SseEvent[] {
    const events = this.ready;
    this.ready = [];
    return events;
  }

  /** Return completed events and discard an unterminated final event. */
  flush(): readonly SseEvent[] {
    this.line = "";
    this.lineBytes = 0;
    this.eventBytes = 0;
    this.eventLength = 0;
    this.dataParts = [];
    this.eventName = "";
    this.hasComment = false;
    this.highSurrogate = "";
    this.skipLf = false;
    return this.drain();
  }

  get pendingLength(): number {
    return this.eventLength + this.line.length + this.highSurrogate.length;
  }

  get emittedCount(): number {
    return this.emitted;
  }
}

/** Consume framed events, releasing the input iterator on done or cancellation. */
export async function* parseSseStream(
  input: AsyncIterable<string> | Iterable<string>,
  doneSentinel: string | null = SSE_DONE_SENTINEL,
  limits?: SseLimits,
): AsyncGenerator<SseEvent, void, unknown> {
  const buffer = new SseBuffer(doneSentinel, limits?.maxEventBytes, limits?.maxLineBytes);
  try {
    for await (const chunk of input) {
      buffer.push(chunk);
      for (const event of buffer.drain()) {
        yield event;
        if (event.type === "done") return;
      }
    }
  } finally {
    buffer.flush();
  }
}

/** Parse a complete response body using the same incremental framing owner. */
export function parseSseText(
  text: string,
  doneSentinel: string | null = SSE_DONE_SENTINEL,
  limits?: SseLimits,
): readonly SseEvent[] {
  const buffer = new SseBuffer(doneSentinel, limits?.maxEventBytes, limits?.maxLineBytes);
  buffer.push(text);
  return buffer.flush();
}
