/**
 * Client error classes — the typed errors the data layer throws.
 *
 * Extracted from `client.ts` so the Broker and `client.ts` share ONE
 * definition rather than the Broker importing from the very module it is
 * replacing (which would make the dependency point backwards and block
 * `client.ts` from eventually being deleted).
 *
 * The CODE vocabulary lives in `shared/errors.ts` and is shared with the
 * server. These classes are the client-side carrier for it.
 */

/** A typed client-side failure carrying a shared taxonomy code. */
export class ClientError extends Error {
  readonly code: string;
  readonly statusCode: number | undefined;
  /**
   * Present when this failure is a two-press confirm's FIRST press: the key
   * of the armed confirm it speaks for. A confirm sentence belongs to the
   * arm that minted it — when the arm moves on (a retarget press on another
   * target replaces it; a perform consumes it), the sentence is no longer
   * any control's to say, and the rendering gate that reads the arm clears
   * the face. Without the key, every control that ever caught the sentence
   * would keep rendering "press again" for an arm that no longer exists
   * (measured live, UIE-043: two beats both claimed "press again" while one
   * arm existed).
   */
  readonly confirmKey: string | undefined;
  /**
   * Present on a `chat_run_live` refusal: the id of the run the refusal is
   * about — the run already live in this conversation. The refusal names its
   * own subject so the send path can ADOPT that run (open its stream, plant
   * its view): a run this client did not start is otherwise invisible in
   * the flow and unreachable by the sentence's steer remedy, and the reader
   * is left watching a live conversation that shows them nothing.
   */
  readonly liveRunId: string | undefined;

  constructor(code: string, message: string, statusCode?: number, confirmKey?: string, liveRunId?: string) {
    super(message);
    this.name = "ClientError";
    this.code = code;
    this.statusCode = statusCode;
    this.confirmKey = confirmKey;
    this.liveRunId = liveRunId;
  }
}

/** The request exceeded the client-side timeout. */
export class ClientTimeoutError extends ClientError {
  constructor(message = "Request timed out") {
    super("timeout", message);
    this.name = "ClientTimeoutError";
  }
}
