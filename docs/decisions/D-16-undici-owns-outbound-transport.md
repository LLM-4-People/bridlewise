---
id: D-16
date: 2026-09-28
by: coordinator
group: process
status: in-force
implementation: done
acted_in: [engine/package.json, engine/src/shared/outbound-http.ts, engine/src/shared/outbound-policy.ts]
---
# undici is the outbound door's one dispatcher

`undici` (Node's own HTTP client) is a direct dependency so the outbound door
owns ONE dispatcher for fetch and WebSocket, with DNS pinning (closing the
pooled keep-alive DNS-pin bypass). Approved for SEC-e.

**Freshness and GOAWAY (the coordinator's round-5 §6 decision, amended
here in LAND-OC-FIX round 12, design LOW 12).** Every connection rides the
door's ONE freshness pool (engine/src/shared/outbound-http.ts): a pooled
connection is reused only while idle < the server's advertised keep-alive
(capped by `network.idleConnectionMs`) minus `network.keepAliveThresholdMs`,
judged at dispatch and again right before the write, so a request is never
written on a connection its server has closed; the clock starts at dispatch
(a stall is never trusted). An HTTP/2 stream above a GOAWAY's last-stream-id
was never processed and is resent once on a new connection; anything the
server took and then cut is never resent. The pool reads undici's internal
symbols, so undici is pinned EXACTLY in engine/package.json (an upgrade is a
reviewed change). Its known costs are owned: HTTP/2 multiplexing is lost
(OUTBOUND-H2-MULTIPLEX) and an h2 response reset mid-body reads as complete
(HTTP2-RST-MIDBODY).

