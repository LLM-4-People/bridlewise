(function () {
  "use strict";

  /* The demo record is embedded so the page also works from file:// with no
     request. run-record.json is the machine-readable mirror of this object. */
  const RECORD = {
    "schema": "bridlewise.run-record/demo@1",
    "illustrative": true,
    "notice": "Illustrative record for documentation. It was not produced by the Bridlewise engine, is not a live model run, and demonstrates no production readiness. The real engine reports harnessReady: false.",
    "run": {
      "id": "0001",
      "title": "trace the request boundary",
      "status": "complete",
      "release": "held",
      "recordedAt": "2026-10-19T14:02:07.412Z",
      "duration": "00:04:18.202",
      "model": "meridian-3-synth",
      "provider": "offscreen mock",
      "project": "harborlight-lab",
      "projectScope": "synthetic fixture",
      "harnessReady": false,
      "preview": "developer preview, pre-admission"
    },
    "gate": {
      "connected": false,
      "note": "This panel is illustrative. The demo is not connected to the Bridlewise engine.",
      "capabilities": [
        {
          "id": "model-invocation",
          "label": "model invocation",
          "decision": "allow",
          "detail": "synthetic adapter only"
        },
        {
          "id": "repository-mutation",
          "label": "repository mutation",
          "decision": "allow",
          "detail": "workspace writes, never commits"
        },
        {
          "id": "process-execution",
          "label": "process execution",
          "decision": "allow",
          "detail": "sandboxed checks, no egress"
        },
        {
          "id": "network-egress",
          "label": "network egress",
          "decision": "deny",
          "detail": "no adapter configured"
        }
      ]
    },
    "beats": [
      {
        "id": "b01",
        "seq": "01",
        "kind": "intent",
        "label": "Intent",
        "timestamp": "14:02:07.412",
        "offsetMs": 0,
        "actor": "operator",
        "title": "Trace the request boundary",
        "summary": "Locate the telemetry ingress seam, pin the missing auth gate with one test, and do not commit.",
        "narrative": "The operator opens a narrow trace-and-pin task. The only intended file effect is one regression test.",
        "causedBy": [],
        "causes": [
          "b02"
        ],
        "policy": {
          "decision": "allow",
          "code": "INGRESS.OPERATOR",
          "label": "Operator-authored request"
        },
        "evidence": [
          {
            "id": "ev.0001.01",
            "label": "Operator brief",
            "detail": "Captured before dispatch · 24 words"
          }
        ],
        "redactions": [],
        "gateCapability": null,
        "gateNote": "Beat 01 · operator intent admitted. No capability invoked.",
        "detail": {
          "type": "intent",
          "quote": "Trace the request boundary around telemetry ingest. Add one regression check that proves whether the auth gate is missing. Keep the change local; do not commit.",
          "constraints": [
            {
              "label": "Write scope",
              "value": "Synthetic workspace"
            },
            {
              "label": "Release",
              "value": "No commit"
            },
            {
              "label": "Failure",
              "value": "Acceptable as evidence"
            }
          ]
        }
      },
      {
        "id": "b02",
        "seq": "02",
        "kind": "model",
        "label": "Model turn",
        "timestamp": "14:02:08.226",
        "offsetMs": 814,
        "actor": "model",
        "title": "Plan the read and the pin",
        "summary": "A synthetic model proposes read, pin, check. No provider request leaves the page.",
        "narrative": "The model names the route seam and the exact check. The turn is authored by the demo, not by a running provider.",
        "causedBy": [
          "b01"
        ],
        "causes": [
          "b03"
        ],
        "policy": {
          "decision": "allow",
          "code": "MODEL.SYNTHETIC",
          "label": "Synthetic provider only"
        },
        "evidence": [
          {
            "id": "ev.0001.02",
            "label": "Synthetic model turn",
            "detail": "Plan accepted · 3 steps · no provider I/O"
          }
        ],
        "redactions": [],
        "gateCapability": "model-invocation",
        "gateNote": "Beat 02 · synthetic model invocation admitted against the offscreen adapter.",
        "detail": {
          "type": "model",
          "providerNote": "offscreen mock · synthetic",
          "plan": [
            {
              "title": "Read the seam",
              "detail": "Inspect the telemetry mount order and the session gate."
            },
            {
              "title": "Pin the hole",
              "detail": "Create one focused regression test; make no source edits."
            },
            {
              "title": "Run it alone",
              "detail": "Record the failure as evidence, then stop."
            }
          ]
        }
      },
      {
        "id": "b03",
        "seq": "03",
        "kind": "tool",
        "label": "Tool call",
        "timestamp": "14:02:09.771",
        "offsetMs": 2359,
        "actor": "tool executor",
        "title": "Search the route seam",
        "summary": "Read-only search finds the route seam and one credential-shaped fixture value.",
        "narrative": "The search returns the ingest handler, its mount point, and a fixture line that looks like a credential. The fixture value is masked before this record renders it.",
        "causedBy": [
          "b02"
        ],
        "causes": [
          "b04"
        ],
        "policy": {
          "decision": "allow",
          "code": "TOOL.READ",
          "label": "Read-only repository search"
        },
        "evidence": [
          {
            "id": "ev.0001.03a",
            "label": "Tool receipt",
            "detail": "search_code · 412 ms · 3 matches"
          },
          {
            "id": "ev.0001.03b",
            "label": "Redaction receipt",
            "detail": "SEC-01 · 1 value masked before display"
          }
        ],
        "redactions": [
          {
            "rule": "SEC-01",
            "surface": "tool output · probe.http:3",
            "masked": "authorization: Bearer ••••••••••••",
            "explanation": "A credential-shaped value in the synthetic fixture was masked before this record rendered it. It was never a real secret and never reached a model."
          }
        ],
        "gateCapability": null,
        "gateNote": "Beat 03 · read-only repository access. No model call, process, or egress.",
        "detail": {
          "type": "tool",
          "tool": {
            "name": "search_code",
            "mode": "read-only",
            "latencyMs": 412,
            "receipt": "tool-0001-03",
            "input": {
              "query": "telemetry ingest",
              "path": "src/server",
              "limit": 6
            },
            "output": {
              "matches": [
                {
                  "path": "src/server/routes/telemetry.ts",
                  "line": 38,
                  "text": "router.post(\"/ingest\", ingest)"
                },
                {
                  "path": "src/server/app.ts",
                  "line": 71,
                  "text": "app.use(\"/telemetry\", telemetry)"
                },
                {
                  "path": "src/server/routes/__fixtures__/probe.http",
                  "line": 3,
                  "text": "authorization: Bearer ••••••••••••"
                }
              ]
            }
          }
        }
      },
      {
        "id": "b04",
        "seq": "04",
        "kind": "effect",
        "label": "File effect",
        "timestamp": "14:03:14.908",
        "offsetMs": 67496,
        "actor": "workspace",
        "title": "Pin the missing gate with one test",
        "summary": "Creates one test file. Source stays untouched; nothing is committed.",
        "narrative": "This is the only file effect in the run: a new test under the synthetic workspace. The source route remains unchanged.",
        "causedBy": [
          "b03"
        ],
        "causes": [
          "b05"
        ],
        "policy": {
          "decision": "allow",
          "code": "WORKSPACE.WRITE",
          "label": "Workspace effect admitted"
        },
        "evidence": [
          {
            "id": "ev.0001.04",
            "label": "Effect receipt",
            "detail": "eff-0001-a · 1 file created · +14 -0"
          }
        ],
        "redactions": [],
        "gateCapability": "repository-mutation",
        "gateNote": "Beat 04 · workspace write admitted. Release actions remain operator-only.",
        "detail": {
          "type": "effect",
          "effect": {
            "id": "eff-0001-a",
            "file": "test/telemetry.ingest.test.ts",
            "change": "created",
            "additions": 14,
            "deletions": 0,
            "digest": "demo:4d1c",
            "patch": "@@ -0,0 +1,14 @@\n+import { test } from \"node:test\";\n+import assert from \"node:assert/strict\";\n+import { createApp } from \"../src/server/app.js\";\n+\n+test(\"telemetry ingest refuses an unauthenticated request\", async () => {\n+  const app = createApp({ auth: \"strict\" });\n+  const response = await app.request(\"/telemetry/ingest\", {\n+    method: \"POST\",\n+    headers: { \"content-type\": \"application/json\" },\n+    body: JSON.stringify({ event: \"boundary-probe\" }),\n+  });\n+\n+  assert.equal(response.status, 401);\n+});"
          }
        }
      },
      {
        "id": "b05",
        "seq": "05",
        "kind": "check",
        "label": "Check",
        "timestamp": "14:03:48.119",
        "offsetMs": 100707,
        "actor": "check runner",
        "title": "The targeted check fails",
        "summary": "The targeted check exits 1: expected 401, received 200.",
        "narrative": "The check is meant to fail until the gate exists. It confirms the missing boundary; it does not prove a fix.",
        "causedBy": [
          "b04"
        ],
        "causes": [
          "b06"
        ],
        "policy": {
          "decision": "allow",
          "code": "PROCESS.CHECK",
          "label": "Sandboxed process, no egress"
        },
        "evidence": [
          {
            "id": "ev.0001.05",
            "label": "Check transcript",
            "detail": "exit 1 · 1 failed · 284 ms"
          }
        ],
        "redactions": [],
        "gateCapability": "process-execution",
        "gateNote": "Beat 05 · sandboxed check admitted. No network egress was attempted.",
        "detail": {
          "type": "check",
          "check": {
            "command": "node --test test/telemetry.ingest.test.ts",
            "status": "failed",
            "exitCode": 1,
            "duration": "00:00.284",
            "summary": "1 failed, 0 passed, 0 skipped",
            "transcript": [
              {
                "tone": "muted",
                "text": "[ RUN  ] telemetry ingest refuses an unauthenticated request"
              },
              {
                "tone": "alarm",
                "text": "[ FAIL ] expected 401, received 200"
              },
              {
                "tone": "muted",
                "text": "         at test/telemetry.ingest.test.ts:13"
              },
              {
                "tone": "muted",
                "text": "         duration 18.42 ms"
              },
              {
                "tone": "alarm",
                "text": "1 failed · 0 passed · 0 skipped"
              }
            ]
          }
        }
      },
      {
        "id": "b06",
        "seq": "06",
        "kind": "finding",
        "label": "Finding",
        "timestamp": "14:04:00.365",
        "offsetMs": 112953,
        "actor": "analysis",
        "title": "Telemetry ingress bypasses the auth gate",
        "summary": "The route accepts unauthenticated ingest. The failed test and mount order are the proof.",
        "narrative": "The failed check is recorded as a high-severity finding. It is a fact with evidence, not a guessed vulnerability.",
        "causedBy": [
          "b05"
        ],
        "causes": [
          "b07"
        ],
        "policy": {
          "decision": "record",
          "code": "FINDING.RECORDED",
          "label": "Recorded for operator review"
        },
        "evidence": [
          {
            "id": "ev.0001.06a",
            "label": "Source pointer",
            "detail": "src/server/app.ts:71 · mount order"
          },
          {
            "id": "ev.0001.06b",
            "label": "Check pointer",
            "detail": "test/telemetry.ingest.test.ts:13 · failed assertion"
          }
        ],
        "redactions": [],
        "gateCapability": null,
        "gateNote": "Beat 06 · finding is advisory. No remediation was auto-dispatched.",
        "detail": {
          "type": "finding",
          "finding": {
            "severity": "high",
            "status": "open",
            "scope": "POST /telemetry/ingest",
            "claim": "The telemetry router is mounted before the session gate, so an unauthenticated payload receives a 200.",
            "evidence": [
              "src/server/app.ts:71 mounts telemetry before requireSession",
              "test/telemetry.ingest.test.ts:13 expected 401, received 200"
            ],
            "remedy": "Mount the telemetry router behind requireSession, then re-run the check. The fix is not applied in this run."
          }
        }
      },
      {
        "id": "b07",
        "seq": "07",
        "kind": "refusal",
        "label": "Governance refusal",
        "timestamp": "14:04:22.006",
        "offsetMs": 134594,
        "actor": "governance",
        "title": "Commit refused at the release gate",
        "summary": "git_commit is refused by the release gate. The workspace remains uncommitted.",
        "narrative": "The model asks to commit the test as a checkpoint. git_commit is a release action, not a workspace write. Governance returns a typed refusal and no retry path.",
        "causedBy": [
          "b06"
        ],
        "causes": [
          "b08"
        ],
        "policy": {
          "decision": "deny",
          "code": "GOV-04",
          "label": "Release actions require an operator"
        },
        "evidence": [
          {
            "id": "ev.0001.07",
            "label": "Refusal receipt",
            "detail": "ref-0001-07 · typed denial · no retry"
          }
        ],
        "redactions": [],
        "gateCapability": "repository-mutation",
        "gateNote": "Beat 07 · release action denied. Workspace write admitted; commit stayed closed.",
        "detail": {
          "type": "refusal",
          "refusal": {
            "receipt": "ref-0001-07",
            "type": "GOVERNANCE_REFUSAL",
            "code": "RELEASE_AUTO_COMMIT_DENIED",
            "action": "git_commit",
            "capability": "repository_mutation.release",
            "decision": "deny",
            "rule": "GOV-04 · release actions are operator-only",
            "attempt": {
              "message": "test: pin telemetry auth boundary",
              "paths": [
                "test/telemetry.ingest.test.ts"
              ]
            },
            "remedy": "Review the diff and commit outside the run. Do not retry the tool call; ask the operator to release it.",
            "retry": "not permitted"
          }
        }
      },
      {
        "id": "b08",
        "seq": "08",
        "kind": "release",
        "label": "Release / decision",
        "timestamp": "14:06:25.614",
        "offsetMs": 258202,
        "actor": "operator gate",
        "title": "Hold for operator review",
        "summary": "The record closes in a held state. No merge, commit, or egress occurred.",
        "narrative": "The record seals with a failing check, an open finding, and a refused commit. Release belongs to the operator.",
        "causedBy": [
          "b07"
        ],
        "causes": [],
        "policy": {
          "decision": "hold",
          "code": "RELEASE.HELD",
          "label": "Release deferred to operator"
        },
        "evidence": [
          {
            "id": "ev.0001.08",
            "label": "Seal receipt",
            "detail": "8/8 beats · 1 refusal · 1 redaction · release held"
          }
        ],
        "redactions": [],
        "gateCapability": null,
        "gateNote": "Beat 08 · operator handoff. No release action executed.",
        "detail": {
          "type": "decision",
          "decision": {
            "verdict": "held",
            "release": "not released",
            "owner": "operator",
            "reason": "A high-severity auth finding is open and the commit was refused.",
            "nextAction": "Review the diff, mount telemetry behind the session gate, re-run the check, then decide on release.",
            "seal": "8/8 beats sealed"
          }
        }
      }
    ]
  };

  const THEME_KEY = "bridlewise:run-demo:theme";
  const BEAT_TOTAL = RECORD.beats.length;
  const beatMap = new Map(RECORD.beats.map(function (beat) {
    return [beat.id, beat];
  }));
  const searchIndex = new Map();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const compactLayout = window.matchMedia("(max-width: 900px)");

  const state = {
    selectedId: null,
    detailOpen: false,
    traceActive: false,
    traceTimer: null,
    traceChain: [],
    traceStep: 0,
    traceHits: [],
    dialogReturnFocus: null
  };

  const dom = {
    runMeta: document.getElementById("run-meta"),
    beatList: document.getElementById("beat-list"),
    timelineCount: document.getElementById("timeline-count"),
    filter: document.getElementById("beat-filter"),
    filterClear: document.getElementById("filter-clear"),
    filterResult: document.getElementById("filter-result"),
    filterEmpty: document.getElementById("filter-empty"),
    inspector: document.getElementById("inspector-panel"),
    inspectorHeading: document.getElementById("inspector-heading"),
    inspectorKicker: document.getElementById("inspector-kicker"),
    inspectorDetail: document.getElementById("inspector-detail"),
    inspectorContent: document.getElementById("inspector-content"),
    inspectorClosed: document.getElementById("inspector-closed"),
    inspectorStatus: document.getElementById("inspector-status"),
    causalChain: document.getElementById("causal-chain"),
    traceButton: document.getElementById("trace-button"),
    traceLabel: document.getElementById("trace-label"),
    collapseDetail: document.getElementById("collapse-detail"),
    reopenDetail: document.getElementById("reopen-detail"),
    gateList: document.getElementById("gate-list"),
    gateCounts: document.getElementById("gate-counts"),
    gateSignal: document.getElementById("gate-signal"),
    themeToggle: document.getElementById("theme-toggle"),
    themeLabel: document.getElementById("theme-label"),
    shortcutsOpen: document.getElementById("shortcuts-open"),
    shortcutsInline: document.getElementById("shortcuts-inline"),
    shortcutsDialog: document.getElementById("shortcuts-dialog"),
    shortcutsClose: document.getElementById("shortcuts-close"),
    shortcutsDone: document.getElementById("shortcuts-done"),
    themeMeta: document.querySelector('meta[name="theme-color"]')
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[character];
    });
  }

  function pad(value, width) {
    return String(value).padStart(width, "0");
  }

  function formatOffset(milliseconds) {
    const total = Math.max(0, Number(milliseconds) || 0);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return "+" + pad(minutes, 2) + ":" + pad(seconds, 2) + "." + pad(millis, 3);
  }

  function pluralize(count, word) {
    return count + " " + word + (count === 1 ? "" : "s");
  }

  function collectStrings(value, output) {
    if (typeof value === "string") {
      output.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (entry) {
        collectStrings(entry, output);
      });
      return;
    }
    if (value && typeof value === "object") {
      Object.keys(value).forEach(function (key) {
        collectStrings(value[key], output);
      });
    }
  }

  function buildSearchIndex() {
    RECORD.beats.forEach(function (beat) {
      const parts = [
        beat.label,
        beat.actor,
        beat.title,
        beat.summary,
        beat.narrative,
        beat.policy.code,
        beat.policy.label
      ];
      beat.evidence.forEach(function (entry) {
        parts.push(entry.id, entry.label, entry.detail);
      });
      beat.redactions.forEach(function (entry) {
        parts.push(entry.rule, entry.surface, entry.explanation);
      });
      collectStrings(beat.detail, parts);
      searchIndex.set(beat.id, parts.join(" ").toLowerCase());
    });
  }

  function announce(message) {
    dom.inspectorStatus.textContent = message;
  }

  function renderRunIdentity() {
    const run = RECORD.run;
    const idLabel = document.getElementById("run-id-label");
    const titleLabel = document.getElementById("run-title-label");
    const statusValue = document.getElementById("run-status");
    const releaseState = document.getElementById("run-release-state");
    if (idLabel) {
      idLabel.textContent = "Run " + run.id;
    }
    if (titleLabel) {
      titleLabel.textContent = run.title;
    }
    if (statusValue) {
      statusValue.textContent = run.status;
    }
    if (releaseState) {
      releaseState.textContent = "release " + run.release;
    }
    document.title = "Run " + run.id + " · " + run.title + " · Bridlewise";
  }

  function renderMeta() {
    const run = RECORD.run;
    const items = [
      {
        label: "Run",
        value: escapeHtml(run.id)
      },
      {
        label: "Status",
        value: escapeHtml(run.status),
        sub: '<span class="meta__sub--warn">release ' + escapeHtml(run.release) + "</span>"
      },
      {
        label: "Duration",
        value: escapeHtml(run.duration)
      },
      {
        label: "Model / provider",
        value: escapeHtml(run.model),
        sub: escapeHtml(run.provider)
      },
      {
        label: "Project",
        value: escapeHtml(run.project),
        sub: escapeHtml(run.projectScope)
      },
      {
        label: "harnessReady",
        labelClass: "meta__label--code",
        value: escapeHtml(String(run.harnessReady)),
        valueClass: "meta__value--warn",
        sub: escapeHtml(run.preview)
      }
    ];

    dom.runMeta.innerHTML = items.map(function (item) {
      return '<div class="meta__item">' +
        '<dt class="meta__label ' + (item.labelClass || "") + '">' + escapeHtml(item.label) + "</dt>" +
        '<dd class="meta__value ' + (item.valueClass || "") + '">' +
          item.value +
          (item.sub ? '<span class="meta__sub">' + item.sub + "</span>" : "") +
        "</dd>" +
      "</div>";
    }).join("");
  }

  function renderGate() {
    dom.gateList.innerHTML = RECORD.gate.capabilities.map(function (capability) {
      return '<li class="gate__item" data-capability="' + escapeHtml(capability.id) + '">' +
        '<span class="gate__cap">' +
          '<span class="gate__name">' + escapeHtml(capability.label) + "</span>" +
          '<span class="gate__state gate__state--' + escapeHtml(capability.decision) + '">' + escapeHtml(capability.decision) + "</span>" +
        "</span>" +
        '<span class="gate__detail">' + escapeHtml(capability.detail) + "</span>" +
      "</li>";
    }).join("");

    const refusals = RECORD.beats.filter(function (beat) {
      return beat.kind === "refusal";
    }).length;
    const redactions = RECORD.beats.reduce(function (total, beat) {
      return total + beat.redactions.length;
    }, 0);

    dom.gateCounts.innerHTML =
      '<div class="gate__count"><span>Refusals</span><strong>' + pad(refusals, 2) + "</strong></div>" +
      '<div class="gate__count"><span>Redactions</span><strong>' + pad(redactions, 2) + "</strong></div>";
  }

  function renderTimeline() {
    dom.timelineCount.textContent = pluralize(BEAT_TOTAL, "beat");
    dom.filterResult.textContent = pluralize(BEAT_TOTAL, "beat");
    dom.filterEmpty.hidden = true;
    dom.filterClear.hidden = true;
    dom.beatList.setAttribute("aria-label", pluralize(BEAT_TOTAL, "causal beat") + ", in order");
    const footerCount = document.getElementById("footer-beat-count");
    if (footerCount) {
      footerCount.textContent = pluralize(BEAT_TOTAL, "beat");
    }

    dom.beatList.innerHTML = RECORD.beats.map(function (beat) {
      return '<li class="beat" data-beat-id="' + escapeHtml(beat.id) + '" data-kind="' + escapeHtml(beat.kind) + '">' +
        '<button class="beat__button" id="beat-' + escapeHtml(beat.id) + '" type="button" data-beat-id="' + escapeHtml(beat.id) + '" aria-controls="inspector-detail" aria-expanded="false">' +
          '<span class="beat__rail" aria-hidden="true">' +
            '<span class="beat__seq">' + escapeHtml(beat.seq) + "</span>" +
            '<span class="beat__node"></span>' +
          "</span>" +
          '<span class="beat__content">' +
            '<span class="beat__topline">' +
              '<span class="beat__type">' + escapeHtml(beat.label) + "</span>" +
              '<span class="beat__actor">' + escapeHtml(beat.actor) + "</span>" +
              '<span class="beat__time">' + escapeHtml(formatOffset(beat.offsetMs)) + "</span>" +
            "</span>" +
            '<span class="beat__title">' + escapeHtml(beat.title) + "</span>" +
            '<span class="beat__summary">' + escapeHtml(beat.summary) + "</span>" +
          "</span>" +
        "</button>" +
      "</li>";
    }).join("");
  }

  function beatLink(id) {
    const beat = beatMap.get(id);
    if (!beat) {
      return "";
    }
    return '<button class="ledger-link" type="button" data-beat-target="' + escapeHtml(id) + '" aria-label="Open beat ' + escapeHtml(beat.seq) + ", " + escapeHtml(beat.label) + ": " + escapeHtml(beat.title) + '">' +
      "<span>" + escapeHtml(beat.seq) + "</span> · " + escapeHtml(beat.label) +
    "</button>";
  }

  function renderCausalChain(beat) {
    const chain = evidenceChain(beat.id);
    const steps = chain.map(function (id, index) {
      const item = beatMap.get(id);
      if (!item) {
        return "";
      }
      const current = id === beat.id;
      return '<li class="causal-chain__step">' +
        '<button class="chain-node" type="button" data-beat-target="' + escapeHtml(item.id) + '"' +
          (current ? ' aria-current="step"' : "") +
          ' aria-label="Open beat ' + escapeHtml(item.seq) + ", " + escapeHtml(item.label) + ": " + escapeHtml(item.title) + '">' +
          escapeHtml(item.seq) + " " + escapeHtml(item.label) +
        "</button>" +
        (index < chain.length - 1 ? '<span class="chain-arrow" aria-hidden="true">→</span>' : "") +
      "</li>";
    }).join("");

    dom.causalChain.innerHTML =
      '<span class="causal-chain__label">Evidence path</span>' +
      '<ol class="causal-chain__steps" aria-label="Evidence path for this beat">' + steps + "</ol>";
  }

  function renderFacts(beat) {
    return '<div class="fact-grid">' +
      '<div class="fact">' +
        '<span class="fact__label">Type</span>' +
        '<span class="fact__value">' + escapeHtml(beat.label) + "</span>" +
        '<span class="fact__sub">Beat ' + escapeHtml(beat.seq) + " / " + pad(BEAT_TOTAL, 2) + "</span>" +
      "</div>" +
      '<div class="fact">' +
        '<span class="fact__label">Timestamp</span>' +
        '<span class="fact__value">' + escapeHtml(beat.timestamp) + "</span>" +
        '<span class="fact__sub">' + escapeHtml(formatOffset(beat.offsetMs)) + "</span>" +
      "</div>" +
      '<div class="fact">' +
        '<span class="fact__label">Actor</span>' +
        '<span class="fact__value fact__value--sans">' + escapeHtml(beat.actor) + "</span>" +
      "</div>" +
      '<div class="fact">' +
        '<span class="fact__label">Policy decision</span>' +
        '<span class="fact__value policy-fact">' +
          '<span class="decision-pill" data-decision="' + escapeHtml(beat.policy.decision) + '">' + escapeHtml(beat.policy.decision) + "</span>" +
          '<span class="policy-code">' + escapeHtml(beat.policy.code) + "</span>" +
        "</span>" +
        '<span class="fact__sub">' + escapeHtml(beat.policy.label) + "</span>" +
      "</div>" +
    "</div>";
  }

  function renderIntent(beat) {
    const detail = beat.detail;
    return '<section class="detail-block" aria-label="Operator brief">' +
      "<h3>Operator brief</h3>" +
      '<blockquote class="quote">' +
        "<p>" + escapeHtml(detail.quote) + "</p>" +
        "<footer>Operator · run " + escapeHtml(RECORD.run.id) + "</footer>" +
      "</blockquote>" +
      '<div class="constraint-grid">' +
        detail.constraints.map(function (constraint) {
          return '<div class="constraint">' +
            '<span class="constraint__label">' + escapeHtml(constraint.label) + "</span>" +
            '<span class="constraint__value">' + escapeHtml(constraint.value) + "</span>" +
          "</div>";
        }).join("") +
      "</div>" +
    "</section>";
  }

  function renderModel(beat) {
    const detail = beat.detail;
    return '<section class="detail-block" aria-label="Synthetic plan">' +
      "<h3>Synthetic plan</h3>" +
      '<div class="model-note">' +
        '<span class="status-chip">synthetic turn</span>' +
        '<span class="tool-readout">' + escapeHtml(detail.providerNote) + "</span>" +
      "</div>" +
      '<ol class="plan">' +
        detail.plan.map(function (step, index) {
          return '<li class="plan__item">' +
            '<span class="plan__num">' + pad(index + 1, 2) + "</span>" +
            "<div>" +
              '<div class="plan__title">' + escapeHtml(step.title) + "</div>" +
              '<p class="plan__detail">' + escapeHtml(step.detail) + "</p>" +
            "</div>" +
          "</li>";
        }).join("") +
      "</ol>" +
    "</section>";
  }

  function renderCodeFrame(label, tag, content, extraClass) {
    return '<div class="code-frame ' + (extraClass || "") + '">' +
      '<div class="code-frame__head"><span>' + escapeHtml(label) + "</span>" +
        (tag ? '<span class="code-frame__tag">' + escapeHtml(tag) + "</span>" : "") +
      "</div>" +
      "<pre><code>" + content + "</code></pre>" +
    "</div>";
  }

  function renderTool(beat) {
    const tool = beat.detail.tool;
    const input = escapeHtml(JSON.stringify(tool.input, null, 2));
    const output = escapeHtml(JSON.stringify(tool.output, null, 2));
    const redaction = beat.redactions[0];

    return '<section class="detail-block" aria-label="Tool call input and output">' +
      "<h3>Tool receipt</h3>" +
      '<div class="tool-strip">' +
        '<span class="tool-name">' + escapeHtml(tool.name) + "</span>" +
        '<span class="status-chip status-chip--ok">' + escapeHtml(tool.mode) + "</span>" +
        '<span class="tool-readout">' + escapeHtml(String(tool.latencyMs)) + " ms · " + escapeHtml(tool.receipt) + "</span>" +
      "</div>" +
      '<div class="code-pair">' +
        '<div class="code-frame">' +
          '<div class="code-frame__head"><span>Input</span><span class="code-frame__tag">request</span></div>' +
          '<pre aria-label="Tool input"><code>' + input + "</code></pre>" +
        "</div>" +
        '<div class="code-frame">' +
          '<div class="code-frame__head"><span>Output</span><span class="code-frame__tag">redacted where needed</span></div>' +
          '<pre aria-label="Tool output"><code>' + output + "</code></pre>" +
        "</div>" +
      "</div>" +
      (redaction ?
        '<aside class="redaction-callout" aria-label="Redaction applied">' +
          '<span class="eyebrow">Redaction applied · ' + escapeHtml(redaction.rule) + "</span>" +
          "<p><code>" + escapeHtml(redaction.masked) + "</code></p>" +
          "<p>" + escapeHtml(redaction.explanation) + "</p>" +
        "</aside>" : "") +
    "</section>";
  }

  function renderDiff(effect) {
    let newLine = 1;
    const lines = effect.patch.split("\n").map(function (raw) {
      if (raw.indexOf("@@") === 0) {
        const match = raw.match(/\+(\d+)/);
        if (match) {
          newLine = Number(match[1]);
        }
        return '<div class="diff__line diff__line--hunk"><span class="diff__num"></span><span class="diff__sign"></span><span class="diff__code">' + escapeHtml(raw) + "</span></div>";
      }
      if (raw.charAt(0) === "+") {
        const number = newLine;
        newLine += 1;
        return '<div class="diff__line diff__line--add"><span class="diff__num">' + number + '</span><span class="diff__sign">+</span><span class="diff__code">' + escapeHtml(raw.slice(1)) + "</span></div>";
      }
      if (raw.charAt(0) === "-") {
        return '<div class="diff__line diff__line--del"><span class="diff__num"></span><span class="diff__sign">−</span><span class="diff__code">' + escapeHtml(raw.slice(1)) + "</span></div>";
      }
      const number = newLine;
      newLine += 1;
      return '<div class="diff__line diff__line--context"><span class="diff__num">' + number + '</span><span class="diff__sign"></span><span class="diff__code">' + escapeHtml(raw) + "</span></div>";
    }).join("");

    return '<section class="detail-block" aria-label="File effect diff">' +
      "<h3>Workspace effect</h3>" +
      '<div class="code-frame diff-frame">' +
        '<div class="code-frame__head">' +
          '<span class="diff-path">' + escapeHtml(effect.file) + "</span>" +
          '<span class="diff-stat">+' + effect.additions + '<span class="del">−' + effect.deletions + "</span></span>" +
        "</div>" +
        '<div class="diff" role="group" aria-label="Diff for ' + escapeHtml(effect.file) + '">' + lines + "</div>" +
      "</div>" +
      '<div class="code-note">' +
        "<span>effect " + escapeHtml(effect.id) + "</span>" +
        "<span>" + escapeHtml(effect.change) + "</span>" +
        "<span>digest " + escapeHtml(effect.digest) + "</span>" +
        "<span>workspace only</span>" +
      "</div>" +
    "</section>";
  }

  function renderCheck(beat) {
    const check = beat.detail.check;
    const transcript = check.transcript.map(function (line) {
      return '<span class="transcript__line transcript__line--' + escapeHtml(line.tone) + '">' + escapeHtml(line.text) + "</span>";
    }).join("");

    return '<section class="detail-block" aria-label="Check transcript">' +
      "<h3>Check transcript</h3>" +
      '<div class="check-head">' +
        '<span class="status-chip status-chip--fail">' + escapeHtml(check.status) + "</span>" +
        '<span class="check-command">' + escapeHtml(check.command) + "</span>" +
        '<span class="tool-readout">exit ' + escapeHtml(String(check.exitCode)) + " · " + escapeHtml(check.duration) + "</span>" +
      "</div>" +
      '<div class="code-frame terminal">' +
        '<div class="code-frame__head"><span>Process transcript</span><span class="code-frame__tag">' + escapeHtml(check.summary) + "</span></div>" +
        '<pre aria-label="Check transcript">' + transcript + "</pre>" +
      "</div>" +
      '<div class="code-note"><span>sandboxed process</span><span>no egress attempted</span></div>' +
    "</section>";
  }

  function renderFinding(beat) {
    const finding = beat.detail.finding;
    return '<section class="detail-block" aria-label="Recorded finding">' +
      "<h3>Recorded finding</h3>" +
      '<div class="finding">' +
        '<div class="finding__head">' +
          '<span class="severity">' + escapeHtml(finding.severity) + "</span>" +
          '<span class="status-chip status-chip--warn">' + escapeHtml(finding.status) + "</span>" +
          '<span class="finding__scope">' + escapeHtml(finding.scope) + "</span>" +
        "</div>" +
        '<p class="finding__claim">' + escapeHtml(finding.claim) + "</p>" +
        '<ul class="finding__evidence" aria-label="Finding evidence">' +
          finding.evidence.map(function (line) {
            return "<li>" + escapeHtml(line) + "</li>";
          }).join("") +
        "</ul>" +
        '<div class="remedy"><strong>Remedy</strong><br>' + escapeHtml(finding.remedy) + "</div>" +
      "</div>" +
    "</section>";
  }

  function renderRefusal(beat) {
    const refusal = beat.detail.refusal;
    const attempt = escapeHtml(JSON.stringify(refusal.attempt, null, 2));
    return '<section class="detail-block" aria-label="Governance refusal receipt">' +
      "<h3>Refusal receipt</h3>" +
      '<div class="receipt">' +
        '<div class="receipt__head">' +
          '<span class="receipt__type">' + escapeHtml(refusal.type) + "</span>" +
          '<span class="receipt__id">' + escapeHtml(refusal.receipt) + " · " + escapeHtml(refusal.code) + "</span>" +
        "</div>" +
        '<dl class="receipt__fields">' +
          '<div class="receipt__field"><dt>Action</dt><dd>' + escapeHtml(refusal.action) + "</dd></div>" +
          '<div class="receipt__field"><dt>Decision</dt><dd>' + escapeHtml(refusal.decision) + "</dd></div>" +
          '<div class="receipt__field"><dt>Capability</dt><dd>' + escapeHtml(refusal.capability) + "</dd></div>" +
          '<div class="receipt__field"><dt>Retry</dt><dd>' + escapeHtml(refusal.retry) + "</dd></div>" +
          '<div class="receipt__field receipt__field--wide"><dt>Rule</dt><dd>' + escapeHtml(refusal.rule) + "</dd></div>" +
        "</dl>" +
      "</div>" +
      '<div class="detail-block" aria-label="Attempted input">' +
        "<h3>Attempted input</h3>" +
        '<div class="code-frame">' +
          '<div class="code-frame__head"><span>Input</span><span class="code-frame__tag">not executed</span></div>' +
          '<pre><code>' + attempt + "</code></pre>" +
        "</div>" +
      "</div>" +
      '<div class="remedy remedy--spaced"><strong>Remedy</strong><br>' + escapeHtml(refusal.remedy) + "</div>" +
    "</section>";
  }

  function renderDecision(beat) {
    const decision = beat.detail.decision;
    return '<section class="detail-block" aria-label="Release decision">' +
      "<h3>Release decision</h3>" +
      '<div class="decision">' +
        '<div class="decision__head">' +
          "<div>" +
            '<div class="decision__verdict">' + escapeHtml(decision.verdict) + "</div>" +
            '<p class="decision__sub">' + escapeHtml(decision.release) + " · " + escapeHtml(decision.seal) + "</p>" +
          "</div>" +
          '<div class="decision__owner"><span>Decision owner</span><span>' + escapeHtml(decision.owner) + "</span></div>" +
        "</div>" +
        '<p class="decision__reason">' + escapeHtml(decision.reason) + "</p>" +
        '<div class="decision__next"><strong>Next action</strong>' + escapeHtml(decision.nextAction) + "</div>" +
      "</div>" +
    "</section>";
  }

  function renderDetail(beat) {
    switch (beat.detail.type) {
      case "intent":
        return renderIntent(beat);
      case "model":
        return renderModel(beat);
      case "tool":
        return renderTool(beat);
      case "effect":
        return renderDiff(beat.detail.effect);
      case "check":
        return renderCheck(beat);
      case "finding":
        return renderFinding(beat);
      case "refusal":
        return renderRefusal(beat);
      case "decision":
        return renderDecision(beat);
      default:
        return "";
    }
  }

  function renderLedger(beat) {
    const cause = beat.causedBy.length ?
      '<div class="ledger__links">' + beat.causedBy.map(beatLink).join("") + "</div>" :
      '<span class="empty-value">Run opened by the operator.</span>';
    const effects = beat.causes.length ?
      '<div class="ledger__links">' + beat.causes.map(beatLink).join("") + "</div>" :
      '<span class="empty-value">Record sealed. No outgoing beat.</span>';

    const evidence = beat.evidence.length ?
      '<ul class="evidence">' + beat.evidence.map(function (entry) {
        return '<li class="evidence__item">' +
          '<span class="evidence__id">' + escapeHtml(entry.id) + "</span>" +
          '<span class="evidence__copy"><strong>' + escapeHtml(entry.label) + "</strong> · " + escapeHtml(entry.detail) + "</span>" +
        "</li>";
      }).join("") + "</ul>" :
      '<span class="empty-value">No evidence attached.</span>';

    const redactions = beat.redactions.length ?
      beat.redactions.map(function (redaction) {
        return '<div class="redaction">' +
          '<code class="redaction__mask">' + escapeHtml(redaction.masked) + "</code>" +
          '<span class="redaction__rule">' + escapeHtml(redaction.rule) + " · " + escapeHtml(redaction.surface) + "</span>" +
          '<p class="redaction__copy">' + escapeHtml(redaction.explanation) + "</p>" +
        "</div>";
      }).join("") :
      '<span class="empty-value">None on this beat.</span>';

    return '<dl class="ledger" aria-label="Beat ledger">' +
      '<div class="ledger__row"><dt class="ledger__label">Cause</dt><dd class="ledger__value">' + cause + "</dd></div>" +
      '<div class="ledger__row"><dt class="ledger__label">Effect</dt><dd class="ledger__value">' + effects + "</dd></div>" +
      '<div class="ledger__row"><dt class="ledger__label">Evidence</dt><dd class="ledger__value">' + evidence + "</dd></div>" +
      '<div class="ledger__row"><dt class="ledger__label">Redactions</dt><dd class="ledger__value">' + redactions + "</dd></div>" +
    "</dl>";
  }

  function updateGate(beat) {
    const items = dom.gateList.querySelectorAll(".gate__item");
    items.forEach(function (item) {
      const active = Boolean(beat.gateCapability) && item.dataset.capability === beat.gateCapability;
      item.classList.toggle("is-active", active);
    });
    dom.gateSignal.textContent = beat.gateNote;
    dom.gateSignal.dataset.tone = beat.policy.decision;
  }

  function updateTraceButton() {
    if (state.traceActive) {
      dom.traceLabel.textContent = "Stop trace";
      dom.traceButton.setAttribute("aria-pressed", "true");
    } else if (state.traceHits.length) {
      dom.traceLabel.textContent = "Trace again";
      dom.traceButton.setAttribute("aria-pressed", "false");
    } else {
      dom.traceLabel.textContent = "Follow evidence";
      dom.traceButton.setAttribute("aria-pressed", "false");
    }
  }

  function applyTraceClasses() {
    const hits = new Set(state.traceHits);
    dom.beatList.querySelectorAll(".beat").forEach(function (item) {
      item.classList.toggle("is-trace-hit", hits.has(item.dataset.beatId));
    });
    updateTraceButton();
  }

  function updateTimelineState() {
    const selected = state.selectedId;
    const selectedBeat = selected ? beatMap.get(selected) : null;
    const directCauses = new Set(selectedBeat ? selectedBeat.causedBy : []);

    dom.beatList.querySelectorAll(".beat").forEach(function (item) {
      const id = item.dataset.beatId;
      const isSelected = id === selected;
      item.classList.toggle("is-open", isSelected && state.detailOpen);
      item.classList.toggle("is-selected", isSelected);
      item.classList.toggle("is-ancestor", directCauses.has(id));
      const button = item.querySelector(".beat__button");
      button.setAttribute("aria-expanded", String(isSelected && state.detailOpen));
      if (isSelected) {
        button.setAttribute("aria-current", "step");
      } else {
        button.removeAttribute("aria-current");
      }
    });

    applyTraceClasses();
  }

  function updateDetailVisibility() {
    dom.inspectorDetail.hidden = !state.detailOpen;
    dom.inspectorClosed.hidden = state.detailOpen;
    dom.collapseDetail.hidden = !state.detailOpen;
  }

  function renderInspector(beat) {
    dom.inspectorKicker.textContent = "02 / Inspector · beat " + beat.seq + " " + beat.label;
    dom.inspectorHeading.textContent = beat.title;
    renderCausalChain(beat);
    dom.inspectorContent.innerHTML =
      renderFacts(beat) +
      '<p class="inspector__narrative">' + escapeHtml(beat.narrative) + "</p>" +
      renderDetail(beat) +
      renderLedger(beat);
    updateDetailVisibility();
  }

  function selectionAnnouncement(beat) {
    return "Beat " + beat.seq + ", " + beat.label + ": " + beat.title + ". " +
      (state.detailOpen ? "Inspector updated." : "Details closed.");
  }

  function selectBeat(id, options) {
    const settings = options || {};
    const beat = beatMap.get(id);
    if (!beat) {
      return;
    }
    if (!settings.preserveTrace) {
      clearTrace({ silent: true });
    }
    state.selectedId = id;
    state.detailOpen = settings.open === undefined ? true : Boolean(settings.open);
    renderInspector(beat);
    updateTimelineState();
    updateGate(beat);
    if (settings.focusInspector) {
      dom.inspectorHeading.focus({ preventScroll: true });
    }
    if (settings.reveal) {
      revealInspector();
    }
    if (settings.announce !== false) {
      announce(selectionAnnouncement(beat));
    }
  }

  function setDetailOpen(open, options) {
    const settings = options || {};
    if (!state.selectedId || state.detailOpen === open) {
      return;
    }
    const beat = beatMap.get(state.selectedId);
    state.detailOpen = open;
    if (!open) {
      clearTrace({ silent: true });
    }
    updateTimelineState();
    updateDetailVisibility();
    if (open) {
      renderInspector(beat);
    }
    if (settings.focusInspector) {
      dom.inspectorHeading.focus({ preventScroll: true });
    }
    if (settings.reveal) {
      revealInspector();
    }
    if (settings.announce !== false && beat) {
      announce("Beat " + beat.seq + " " + beat.label + " details " + (open ? "opened." : "closed."));
    }
  }

  function revealInspector() {
    if (!compactLayout.matches) {
      return;
    }
    const top = dom.inspector.getBoundingClientRect().top + window.scrollY - 8;
    window.scrollTo({
      top: top,
      behavior: reducedMotion.matches ? "auto" : "smooth"
    });
  }

  function focusBeatRow(id) {
    const button = document.getElementById("beat-" + id);
    if (!button) {
      return;
    }
    if (button.offsetParent === null) {
      dom.filter.focus({ preventScroll: true });
      return;
    }
    button.focus({ preventScroll: true });
    button.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reducedMotion.matches ? "auto" : "smooth"
    });
  }

  function visibleBeatButtons() {
    return Array.from(dom.beatList.querySelectorAll(".beat:not([hidden]) .beat__button"));
  }

  function moveBeat(direction) {
    const buttons = visibleBeatButtons();
    if (!buttons.length) {
      announce("No beats match the current filter.");
      return;
    }
    const focusedBeat = document.activeElement instanceof Element ?
      document.activeElement.closest(".beat__button") : null;
    const referenceId = focusedBeat ? focusedBeat.dataset.beatId : state.selectedId;
    const current = buttons.findIndex(function (button) {
      return button.dataset.beatId === referenceId;
    });
    let next;
    if (current === -1) {
      next = direction > 0 ? 0 : buttons.length - 1;
    } else {
      next = Math.min(buttons.length - 1, Math.max(0, current + direction));
    }
    if (next === current) {
      announce(direction > 0 ? "End of the visible record." : "Start of the visible record.");
      return;
    }
    const id = buttons[next].dataset.beatId;
    selectBeat(id, { open: true });
    focusBeatRow(id);
  }

  function evidenceChain(id) {
    const beat = beatMap.get(id);
    if (!beat) {
      return [];
    }
    const upstreamId = beat.causedBy[0];
    const downstreamId = beat.causes[0];
    let ids = [id];

    if (upstreamId && downstreamId) {
      ids = [upstreamId, id, downstreamId];
    } else if (upstreamId) {
      const upstream = beatMap.get(upstreamId);
      const upstreamCause = upstream && upstream.causedBy[0];
      ids = upstreamCause ? [upstreamCause, upstreamId, id] : [upstreamId, id];
    } else if (downstreamId) {
      const downstream = beatMap.get(downstreamId);
      const downstreamCause = downstream && downstream.causes[0];
      ids = downstreamCause ? [id, downstreamId, downstreamCause] : [id, downstreamId];
    }

    return ids.filter(function (value, index) {
      return beatMap.has(value) && ids.indexOf(value) === index;
    });
  }

  function clearTrace(options) {
    const settings = options || {};
    if (state.traceTimer) {
      window.clearTimeout(state.traceTimer);
      state.traceTimer = null;
    }
    const hadTrace = state.traceActive || state.traceHits.length > 0;
    state.traceActive = false;
    state.traceChain = [];
    state.traceStep = 0;
    state.traceHits = [];
    applyTraceClasses();
    if (hadTrace && !settings.silent) {
      announce("Evidence trace cleared.");
    }
  }

  function finishTrace() {
    if (state.traceTimer) {
      window.clearTimeout(state.traceTimer);
      state.traceTimer = null;
    }
    const finalBeat = beatMap.get(state.selectedId);
    state.traceActive = false;
    updateTraceButton();
    applyTraceClasses();
    if (finalBeat) {
      announce("Evidence trace complete. " + pluralize(state.traceChain.length, "beat") +
        " on the path. Current beat " + finalBeat.seq + ", " + finalBeat.label +
        ": " + finalBeat.title + ".");
    }
  }

  function traceNextStep() {
    if (!state.traceActive) {
      return;
    }
    const id = state.traceChain[state.traceStep];
    if (!id) {
      finishTrace();
      return;
    }
    if (state.traceHits.indexOf(id) === -1) {
      state.traceHits.push(id);
    }
    selectBeat(id, {
      open: true,
      preserveTrace: true,
      announce: false
    });
    applyTraceClasses();

    const beat = beatMap.get(id);
    if (beat) {
      announce("Evidence trace " + (state.traceStep + 1) + " of " + state.traceChain.length +
        ". Beat " + beat.seq + ", " + beat.label + ": " + beat.title + ".");
    }

    state.traceStep += 1;
    if (state.traceStep < state.traceChain.length) {
      state.traceTimer = window.setTimeout(traceNextStep, 1450);
    } else {
      finishTrace();
    }
  }

  function toggleTrace() {
    if (state.traceActive) {
      clearTrace();
      return;
    }
    if (!state.selectedId) {
      return;
    }
    clearTrace({ silent: true });
    if (!state.detailOpen) {
      state.detailOpen = true;
      updateTimelineState();
      updateDetailVisibility();
    }
    state.traceActive = true;
    state.traceChain = evidenceChain(state.selectedId);
    state.traceStep = 0;
    state.traceHits = [];
    updateTraceButton();
    traceNextStep();
  }

  function filterBeats() {
    const query = dom.filter.value.trim().toLowerCase();
    const visible = [];
    RECORD.beats.forEach(function (beat) {
      const item = dom.beatList.querySelector('.beat[data-beat-id="' + beat.id + '"]');
      const matches = !query || (searchIndex.get(beat.id) || "").indexOf(query) !== -1;
      if (item) {
        item.hidden = !matches;
      }
      if (matches) {
        visible.push(beat);
      }
    });

    dom.filterClear.hidden = query.length === 0;
    dom.filterEmpty.hidden = visible.length !== 0 || query.length === 0;
    dom.filterResult.textContent = query ?
      visible.length + " of " + pluralize(BEAT_TOTAL, "beat") :
      pluralize(BEAT_TOTAL, "beat");

    if (state.traceActive || state.traceHits.length) {
      clearTrace({ silent: true });
    }
  }

  function clearFilter(options) {
    const settings = options || {};
    dom.filter.value = "";
    filterBeats();
    if (settings.focus !== false) {
      dom.filter.focus();
    }
    announce("Filter cleared. " + pluralize(BEAT_TOTAL, "beats") + " visible.");
  }

  function applyTheme(theme, options) {
    const settings = options || {};
    const resolved = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", resolved);

    const label = resolved === "light" ? "carbon" : "logbook";
    const currentName = resolved === "light" ? "Logbook light" : "Carbon dark";
    const nextName = resolved === "light" ? "carbon dark" : "logbook light";

    dom.themeLabel.textContent = label;
    dom.themeToggle.setAttribute(
      "aria-label",
      currentName + " theme active. Switch to the " + nextName + " theme."
    );
    dom.themeToggle.title = "Switch to the " + nextName + " theme";
    if (dom.themeMeta) {
      dom.themeMeta.setAttribute("content", resolved === "light" ? "#f4f1ea" : "#0b0d11");
    }

    if (settings.persist !== false) {
      try {
        localStorage.setItem(THEME_KEY, resolved);
      } catch (error) {
        if (settings.announce !== false) {
          announce("Theme changed for this view. Local storage is unavailable, so the choice will not persist.");
        }
        return;
      }
    }

    if (settings.announce) {
      announce(currentName + " theme active.");
    }
  }

  function initialiseTheme() {
    const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    applyTheme(current, { persist: false, announce: false });
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    applyTheme(current === "light" ? "dark" : "light", { persist: true, announce: true });
  }

  function openShortcuts(trigger) {
    if (state.traceActive) {
      clearTrace({ silent: true });
    }
    const active = document.activeElement;
    state.dialogReturnFocus = trigger ||
      (active instanceof HTMLElement && active !== document.body ? active : dom.shortcutsOpen);
    if (typeof dom.shortcutsDialog.showModal === "function") {
      if (!dom.shortcutsDialog.open) {
        dom.shortcutsDialog.showModal();
      }
    } else {
      dom.shortcutsDialog.setAttribute("open", "");
    }
    dom.shortcutsClose.focus();
  }

  function closeShortcuts() {
    if (typeof dom.shortcutsDialog.close === "function" && dom.shortcutsDialog.open) {
      dom.shortcutsDialog.close();
    } else {
      dom.shortcutsDialog.removeAttribute("open");
      restoreShortcutFocus();
    }
  }

  function restoreShortcutFocus() {
    if (state.dialogReturnFocus && document.contains(state.dialogReturnFocus)) {
      state.dialogReturnFocus.focus();
    }
    state.dialogReturnFocus = null;
  }

  function handleGlobalKeydown(event) {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }
    if (dom.shortcutsDialog.open) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const target = event.target;
    const typing = target instanceof HTMLElement && (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable
    );

    if (event.key === "Escape") {
      if (target === dom.filter) {
        event.preventDefault();
        if (dom.filter.value) {
          clearFilter();
        } else {
          dom.filter.blur();
        }
        return;
      }
      if (typing) {
        return;
      }
      if (state.detailOpen) {
        event.preventDefault();
        setDetailOpen(false, { announce: true });
        focusBeatRow(state.selectedId);
        return;
      }
      if (state.traceHits.length) {
        event.preventDefault();
        clearTrace();
        return;
      }
      return;
    }

    if (typing) {
      return;
    }

    if (event.key === "/") {
      event.preventDefault();
      dom.filter.focus();
      dom.filter.select();
      return;
    }

    if (event.key === "?") {
      event.preventDefault();
      openShortcuts();
      return;
    }

    if (event.key === "j" || event.key === "J" || event.key === "ArrowDown") {
      event.preventDefault();
      moveBeat(1);
      return;
    }

    if (event.key === "k" || event.key === "K" || event.key === "ArrowUp") {
      event.preventDefault();
      moveBeat(-1);
    }
  }

  function bindEvents() {
    dom.beatList.addEventListener("click", function (event) {
      const target = event.target instanceof Element ? event.target.closest(".beat__button") : null;
      if (!target) {
        return;
      }
      const id = target.dataset.beatId;
      const pointerClick = event.detail > 0;
      if (state.selectedId === id) {
        setDetailOpen(!state.detailOpen, {
          announce: true,
          reveal: state.detailOpen ? false : pointerClick
        });
      } else {
        selectBeat(id, { open: true, announce: true, reveal: pointerClick });
      }
    });

    dom.traceButton.addEventListener("click", toggleTrace);

    dom.collapseDetail.addEventListener("click", function () {
      setDetailOpen(false, { announce: true });
      focusBeatRow(state.selectedId);
    });

    dom.reopenDetail.addEventListener("click", function () {
      setDetailOpen(true, { announce: true, focusInspector: true });
    });

    dom.inspector.addEventListener("click", function (event) {
      const target = event.target instanceof Element ? event.target.closest("[data-beat-target]") : null;
      if (!target) {
        return;
      }
      const id = target.dataset.beatTarget;
      if (!id) {
        return;
      }
      selectBeat(id, { open: true, announce: true, focusInspector: true });
    });

    dom.filter.addEventListener("input", filterBeats);

    dom.filterClear.addEventListener("click", function () {
      clearFilter();
    });

    dom.themeToggle.addEventListener("click", toggleTheme);

    dom.shortcutsOpen.addEventListener("click", function () {
      openShortcuts(dom.shortcutsOpen);
    });
    dom.shortcutsInline.addEventListener("click", function () {
      openShortcuts(dom.shortcutsInline);
    });
    dom.shortcutsClose.addEventListener("click", closeShortcuts);
    dom.shortcutsDone.addEventListener("click", closeShortcuts);

    dom.shortcutsDialog.addEventListener("click", function (event) {
      if (event.target === dom.shortcutsDialog) {
        closeShortcuts();
      }
    });

    dom.shortcutsDialog.addEventListener("close", restoreShortcutFocus);

    document.addEventListener("keydown", handleGlobalKeydown);

    window.addEventListener("storage", function (event) {
      if (event.key !== THEME_KEY) {
        return;
      }
      applyTheme(event.newValue === "light" ? "light" : "dark", {
        persist: false,
        announce: true
      });
    });

    window.addEventListener("pagehide", function () {
      if (state.traceTimer) {
        window.clearTimeout(state.traceTimer);
        state.traceTimer = null;
      }
    });
  }

  function initialise() {
    buildSearchIndex();
    initialiseTheme();
    renderRunIdentity();
    renderMeta();
    renderGate();
    renderTimeline();
    bindEvents();
    selectBeat(RECORD.beats[0].id, {
      open: true,
      announce: false
    });
    document.documentElement.setAttribute("data-run-demo-ready", "true");
    window.__BRIDLEWISE_RUN_RECORD__ = RECORD;
  }

  try {
    initialise();
  } catch (error) {
    console.error("The illustrative run record could not be rendered.", error);
    const fallback = document.getElementById("inspector-content");
    if (fallback) {
      fallback.innerHTML = '<p class="inspector__loading">The record could not be rendered. Reload the page or inspect run-record.json directly.</p>';
    }
    const list = document.getElementById("beat-list");
    if (list) {
      list.innerHTML = '<li class="timeline__empty">The causal timeline could not be rendered.</li>';
    }
  }
}());
