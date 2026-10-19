/* ==========================================================================
   Bridlewise Governance Lab — illustrative interaction model.
   No network requests, storage, or engine calls. All state is page-local.
   ========================================================================== */

(function () {
  "use strict";

  const CAPABILITIES = [
    {
      id: "preflight",
      name: "Preflight",
      refusalCode: "preflight_required",
      kind: "root"
    },
    {
      id: "modelInvocation",
      name: "Model invocation",
      refusalCode: "model_invocation_unadmitted",
      kind: "effect"
    },
    {
      id: "repositoryMutation",
      name: "Repository mutation",
      refusalCode: "repository_mutation_unadmitted",
      kind: "effect"
    },
    {
      id: "processExecution",
      name: "Process execution",
      refusalCode: "process_execution_unadmitted",
      kind: "effect"
    },
    {
      id: "networkEgress",
      name: "Network egress",
      refusalCode: "network_egress_unadmitted",
      kind: "effect"
    },
    {
      id: "durableAudit",
      name: "Durable audit",
      refusalCode: "durable_audit_unadmitted",
      kind: "audit"
    }
  ];

  const INITIAL_CAPS = Object.freeze({
    preflight: true,
    modelInvocation: false,
    repositoryMutation: false,
    processExecution: false,
    networkEgress: false,
    durableAudit: false
  });

  const EFFECT_IDS = Object.freeze([
    "modelInvocation",
    "repositoryMutation",
    "processExecution",
    "networkEgress"
  ]);

  const GATE_NAMES = Object.freeze({
    preflight: "preflight",
    modelInvocation: "model invocation",
    repositoryMutation: "repository mutation",
    processExecution: "process execution",
    networkEgress: "network egress",
    durableAudit: "durable audit"
  });

  const FLOOR_RULES = Object.freeze({
    no_writes_outside_project: { code: "SF-01", title: "No writes outside project" },
    no_credentials_in_records: { code: "SF-02", title: "No credentials in records" },
    no_raw_secret_display: { code: "SF-03", title: "No raw secret display" },
    no_silent_fallback: { code: "SF-04", title: "No silent fallback" },
    no_auto_commit: { code: "SF-05", title: "No auto-commit" }
  });

  const ACTIONS = Object.freeze({
    read_file: {
      capability: "preflight",
      effect: false,
      refusalCode: "preflight_required",
      refusalReason:
        "Preflight is withdrawn. No downstream capability can act while the root gate is unverified.",
      successCode: "read_only_inspection",
      successReason:
        "Read-only inspection passed the preflight gate. No file is read; the beat is a session record."
    },
    edit_file: {
      capability: "repositoryMutation",
      effect: true,
      refusalCode: "repository_mutation_unadmitted",
      refusalReason:
        "Repository mutation is not admitted. The gate returns a typed refusal before any path is touched.",
      successCode: "simulated_mutation_recorded",
      successReason:
        "Repository mutation and durable audit are admitted. The edit is simulated inside the modeled project root; no file changes."
    },
    run_command: {
      capability: "processExecution",
      effect: true,
      refusalCode: "process_execution_unadmitted",
      refusalReason:
        "Process execution is not admitted. The gate returns a typed refusal before any child process is spawned.",
      successCode: "simulated_process_bounded",
      successReason:
        "Process execution and durable audit are admitted. The command is simulated with a bounded lifetime; no process starts."
    },
    fetch_url: {
      capability: "networkEgress",
      effect: true,
      refusalCode: "network_egress_unadmitted",
      refusalReason:
        "Network egress is not admitted. The gate returns a typed refusal before any destination is resolved.",
      successCode: "simulated_egress_declared",
      successReason:
        "Network egress and durable audit are admitted. One declared destination is simulated; no request leaves the page."
    },
    git_commit: {
      capability: null,
      effect: true,
      refusalCode: "human_commit_approval_required",
      successCode: null,
      successReason: "",
      floorRule: "no_auto_commit"
    },
    model_call: {
      capability: "modelInvocation",
      effect: true,
      refusalCode: "model_invocation_unadmitted",
      refusalReason:
        "Model invocation is not admitted. The gate returns a typed refusal before any provider call is constructed.",
      successCode: "simulated_model_invoked",
      successReason:
        "Model invocation and durable audit are admitted. The call is simulated; no provider is contacted."
    }
  });

  const state = {
    caps: Object.assign({}, INITIAL_CAPS),
    lastFloorRefusal: null,
    floorRefusals: 0
  };

  let beats = [];
  let beatSeq = 0;
  let currentReceipt = null;
  let copyTimer = null;
  let floorFlashTimer = null;

  const dom = {};

  function cacheDom() {
    dom.receiptLive = document.getElementById("receipt-live");
    dom.receiptReady = document.getElementById("receipt-ready");
    dom.receiptStage = document.getElementById("receipt-stage");
    dom.receiptAllowed = document.getElementById("receipt-allowed");
    dom.receiptDenied = document.getElementById("receipt-denied");
    dom.receiptDigest = document.getElementById("receipt-digest");
    dom.receiptCode = document.getElementById("receipt-code");
    dom.diffBody = document.getElementById("diff-body");
    dom.diffCount = document.getElementById("diff-count");
    dom.copyButton = document.getElementById("copy-receipt");
    dom.copyLabel = dom.copyButton.querySelector(".copy-label");
    dom.floorStatus = document.getElementById("floor-status");
    dom.floorStatusText = document.getElementById("floor-status-text");
    dom.beatList = document.getElementById("beat-list");
    dom.beatCount = document.getElementById("beat-count");
    dom.outcome = document.getElementById("outcome");
    dom.outcomeTarget = document.getElementById("outcome-target");
    dom.outcomeDecision = document.getElementById("outcome-decision");
    dom.outcomeCode = document.getElementById("outcome-code");
    dom.outcomeReason = document.getElementById("outcome-reason");
    dom.outcomeMeta = document.getElementById("outcome-meta");
    dom.reset = document.getElementById("reset-lab");
    dom.switches = Array.from(document.querySelectorAll(".switch"));
    dom.actions = Array.from(document.querySelectorAll(".action"));
    dom.receiptCodeWrap = document.querySelector(".receipt-code-wrap");
    dom.copyStatus = document.getElementById("copy-status");
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function timeNow() {
    const now = new Date();
    return pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds());
  }

  function admittedCount() {
    return CAPABILITIES.filter(function (cap) {
      return state.caps[cap.id];
    }).length;
  }

  function admittedEffects() {
    return EFFECT_IDS.filter(function (id) {
      return state.caps[id];
    });
  }

  function allAdmitted() {
    return admittedCount() === CAPABILITIES.length;
  }

  function deriveStage() {
    if (!state.caps.preflight) {
      return "s0-preflight-unverified";
    }
    if (allAdmitted()) {
      return "s3-all-gates-open";
    }
    const downstream = CAPABILITIES.some(function (cap) {
      return cap.id !== "preflight" && state.caps[cap.id];
    });
    return downstream ? "s2-partial-admission" : "s1-preflight-only";
  }

  function floorRuleLabel(ruleId) {
    const rule = FLOOR_RULES[ruleId];
    return rule ? rule.code + " " + rule.title : ruleId;
  }

  /* ── Canonical-style receipt ─────────────────────────────────────────── */

  function sortValue(value) {
    if (Array.isArray(value)) {
      return value.map(sortValue);
    }
    if (value && typeof value === "object") {
      const sorted = {};
      Object.keys(value).sort().forEach(function (key) {
        sorted[key] = sortValue(value[key]);
      });
      return sorted;
    }
    return value;
  }

  function canonicalString(value) {
    return JSON.stringify(sortValue(value));
  }

  function fnv1a64(text) {
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    let hash = 0xcbf29ce484222325n;
    const bytes = new TextEncoder().encode(text);
    for (let index = 0; index < bytes.length; index += 1) {
      hash ^= BigInt(bytes[index]);
      hash = (hash * prime) & mask;
    }
    return hash;
  }

  function buildReceipt() {
    const allowed = admittedCount();
    const denied = CAPABILITIES.length - allowed;
    const harnessReady = allowed === CAPABILITIES.length;
    const capabilityRows = CAPABILITIES.map(function (cap) {
      const admitted = state.caps[cap.id];
      return {
        id: cap.id,
        decision: admitted ? "allow" : "deny",
        effectAuthorized: false,
        refusalCode: admitted ? null : cap.refusalCode,
        required: true
      };
    });
    const receipt = {
      schemaVersion: 1,
      engineConnected: false,
      claim: "modeled-governance-not-admission",
      stage: deriveStage(),
      harnessReady: harnessReady,
      capabilities: capabilityRows,
      counts: {
        allowed: allowed,
        denied: denied,
        required: CAPABILITIES.length
      },
      floor: {
        status: "satisfied",
        rules: 5,
        mutable: false
      }
    };
    const hash = "fnv1a64:" + fnv1a64(canonicalString(receipt)).toString(16).padStart(16, "0");
    const finalReceipt = Object.assign({}, receipt, { receiptHash: hash });
    const lines = [];

    function addLine(lineText, path, value) {
      lines.push({ text: lineText, path: path || null, value: value });
    }

    addLine("{");
    addLine('  "schemaVersion": 1,', ["schemaVersion"], finalReceipt.schemaVersion);
    addLine('  "engineConnected": false,', ["engineConnected"], finalReceipt.engineConnected);
    addLine('  "claim": ' + JSON.stringify(finalReceipt.claim) + ',', ["claim"], finalReceipt.claim);
    addLine('  "stage": ' + JSON.stringify(finalReceipt.stage) + ',', ["stage"], finalReceipt.stage);
    addLine(
      '  "harnessReady": ' + (finalReceipt.harnessReady ? "true" : "false") + ',',
      ["harnessReady"],
      finalReceipt.harnessReady
    );
    addLine('  "capabilities": [');
    finalReceipt.capabilities.forEach(function (cap, index) {
      addLine("    {");
      addLine('      "id": ' + JSON.stringify(cap.id) + ',', ["capabilities", index, "id"], cap.id);
      addLine(
        '      "decision": ' + JSON.stringify(cap.decision) + ',',
        ["capabilities", index, "decision"],
        cap.decision
      );
      addLine(
        '      "effectAuthorized": false,',
        ["capabilities", index, "effectAuthorized"],
        cap.effectAuthorized
      );
      addLine(
        '      "refusalCode": ' + JSON.stringify(cap.refusalCode) + ',',
        ["capabilities", index, "refusalCode"],
        cap.refusalCode
      );
      addLine('      "required": true', ["capabilities", index, "required"], cap.required);
      addLine("    }" + (index < finalReceipt.capabilities.length - 1 ? "," : ""));
    });
    addLine("  ],");
    addLine('  "counts": {');
    addLine('    "allowed": ' + finalReceipt.counts.allowed + ',', ["counts", "allowed"], finalReceipt.counts.allowed);
    addLine('    "denied": ' + finalReceipt.counts.denied + ',', ["counts", "denied"], finalReceipt.counts.denied);
    addLine(
      '    "required": ' + finalReceipt.counts.required,
      ["counts", "required"],
      finalReceipt.counts.required
    );
    addLine("  },");
    addLine('  "floor": {');
    addLine(
      '    "status": ' + JSON.stringify(finalReceipt.floor.status) + ',',
      ["floor", "status"],
      finalReceipt.floor.status
    );
    addLine('    "rules": ' + finalReceipt.floor.rules + ',', ["floor", "rules"], finalReceipt.floor.rules);
    addLine(
      '    "mutable": ' + (finalReceipt.floor.mutable ? "true" : "false"),
      ["floor", "mutable"],
      finalReceipt.floor.mutable
    );
    addLine("  },");
    addLine('  "receiptHash": ' + JSON.stringify(hash), ["receiptHash"], hash);
    addLine("}");

    return {
      text: lines.map(function (line) { return line.text; }).join("\n"),
      lines: lines,
      hash: hash,
      ready: harnessReady,
      allowed: allowed,
      denied: denied,
      stage: receipt.stage,
      capabilities: finalReceipt.capabilities
    };
  }

  /* ── Receipt rendering ───────────────────────────────────────────────── */

  function tokenizeJsonLine(line) {
    const tokenPattern =
      /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|-?\d+(?:\.\d+)?|[{}\[\],:]/g;
    const code = document.createElement("code");
    let lastIndex = 0;
    let match = tokenPattern.exec(line);

    while (match !== null) {
      if (match.index > lastIndex) {
        code.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
      }
      const token = document.createElement("span");
      const text = match[0];
      if (match[1]) {
        token.className = "tok-key";
      } else if (match[2]) {
        token.className = "tok-string";
      } else if (match[3]) {
        token.className = text === "null" ? "tok-null" : "tok-bool";
      } else if (/^-?\d/.test(text)) {
        token.className = "tok-number";
      } else {
        token.className = "tok-punct";
      }
      token.textContent = text;
      code.appendChild(token);
      lastIndex = match.index + text.length;
      match = tokenPattern.exec(line);
    }

    if (lastIndex < line.length) {
      code.appendChild(document.createTextNode(line.slice(lastIndex)));
    }
    return code;
  }

  function renderReceiptLines(lines, changedIndexes) {
    const fragment = document.createDocumentFragment();

    lines.forEach(function (line, index) {
      const item = document.createElement("li");
      if (changedIndexes.has(index)) {
        item.className = "is-changed";
      }
      const lineNumber = document.createElement("span");
      lineNumber.className = "line-no";
      lineNumber.setAttribute("aria-hidden", "true");
      lineNumber.textContent = pad2(index + 1);
      item.appendChild(lineNumber);
      item.appendChild(tokenizeJsonLine(line.text));
      fragment.appendChild(item);
    });

    dom.receiptCode.replaceChildren(fragment);
  }

  function pathKey(path) {
    return path.join("/");
  }

  function pathLabel(path, receipt) {
    if (path[0] === "capabilities") {
      const capability = receipt.capabilities[path[1]];
      const id = capability ? capability.id : "capabilities[" + path[1] + "]";
      return id + "." + path.slice(2).join(".");
    }
    return path.join(".");
  }

  function compareReceipts(previous, fresh) {
    if (!previous) {
      return [];
    }

    const previousByPath = new Map();
    previous.lines.forEach(function (line) {
      if (line.path) {
        previousByPath.set(pathKey(line.path), line);
      }
    });

    const freshPaths = new Set();
    fresh.lines.forEach(function (line) {
      if (line.path) {
        freshPaths.add(pathKey(line.path));
      }
    });

    const changes = [];

    fresh.lines.forEach(function (line, index) {
      if (!line.path) {
        return;
      }
      const key = pathKey(line.path);
      const oldLine = previousByPath.get(key);
      if (!oldLine || !Object.is(oldLine.value, line.value)) {
        changes.push({
          index: index,
          label: pathLabel(line.path, fresh),
          oldText: oldLine ? oldLine.text : null,
          newText: line.text
        });
      }
    });

    previous.lines.forEach(function (line) {
      if (!line.path || freshPaths.has(pathKey(line.path))) {
        return;
      }
      changes.push({
        index: -1,
        label: pathLabel(line.path, previous),
        oldText: line.text,
        newText: null
      });
    });

    return changes;
  }

  function makeDiffLine(kind, text) {
    const line = document.createElement("div");
    line.className = "diff-line diff-" + kind;
    const sign = document.createElement("span");
    sign.className = "diff-sign";
    sign.setAttribute("aria-hidden", "true");
    sign.textContent = kind === "add" ? "+" : "−";
    const code = document.createElement("code");
    code.textContent = text.trim();
    line.appendChild(sign);
    line.appendChild(code);
    return line;
  }

  function renderDiff(changes) {
    if (changes.length === 0) {
      dom.diffBody.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "diff-empty";
      empty.textContent = "No receipt fields changed.";
      dom.diffBody.appendChild(empty);
      dom.diffCount.textContent = "no change";
      return;
    }

    const limit = 10;
    const fragment = document.createDocumentFragment();

    changes.slice(0, limit).forEach(function (change) {
      const block = document.createElement("div");
      block.className = "diff-change";

      const path = document.createElement("span");
      path.className = "diff-path";
      path.textContent = change.label;
      block.appendChild(path);

      if (change.oldText !== null) {
        block.appendChild(makeDiffLine("remove", change.oldText));
      }
      if (change.newText !== null) {
        block.appendChild(makeDiffLine("add", change.newText));
      }
      fragment.appendChild(block);
    });

    dom.diffBody.replaceChildren(fragment);

    if (changes.length > limit) {
      const more = document.createElement("p");
      more.className = "diff-more";
      more.textContent =
        changes.length -
        limit +
        " more field" +
        (changes.length - limit === 1 ? "" : "s") +
        " changed. The full state is in the receipt and Copy.";
      dom.diffBody.appendChild(more);
    }

    dom.diffCount.textContent =
      changes.length + " field" + (changes.length === 1 ? "" : "s") + " changed";
  }

  function updateReceipt(announcement) {
    const fresh = buildReceipt();
    const changes = compareReceipts(currentReceipt, fresh);
    const changedIndexes = new Set();

    changes.forEach(function (change) {
      if (change.index >= 0) {
        changedIndexes.add(change.index);
      }
    });

    renderReceiptLines(fresh.lines, changedIndexes);

    if (changes.length > 0) {
      renderDiff(changes);
    } else if (!currentReceipt) {
      dom.diffCount.textContent = "no change";
    }

    dom.receiptReady.textContent = fresh.ready ? "true" : "false";
    dom.receiptReady.dataset.state = fresh.ready ? "allow" : "deny";
    dom.receiptStage.textContent = fresh.stage;
    dom.receiptAllowed.textContent = String(fresh.allowed);
    dom.receiptDenied.textContent = String(fresh.denied);
    dom.receiptDigest.textContent = fresh.hash;

    if (announcement) {
      setReceiptLive(
        announcement +
          (changes.length > 0
            ? " Receipt diff: " +
              changes.length +
              " field" +
              (changes.length === 1 ? "" : "s") +
              " changed."
            : "")
      );
    } else {
      setReceiptLive(
        "Modeled receipt: harnessReady " +
          (fresh.ready ? "true" : "false") +
          "; " +
          fresh.allowed +
          " admitted, " +
          fresh.denied +
          " denied; stage " +
          fresh.stage +
          "."
      );
    }

    currentReceipt = fresh;
  }

  function setReceiptLive(text) {
    dom.receiptLive.textContent = text;
  }

  /* ── Floor and capability state ──────────────────────────────────────── */

  function updateFloorStatus() {
    const last = state.lastFloorRefusal;
    if (last) {
      dom.floorStatusText.textContent =
        "5 / 5 rules intact · " +
        state.floorRefusals +
        " floor refusal" +
        (state.floorRefusals === 1 ? "" : "s") +
        " · last " +
        last.code +
        " (" +
        floorRuleLabel(last.rule) +
        ")";
    } else {
      dom.floorStatusText.textContent = "5 / 5 rules intact · no floor refusals this session";
    }
  }

  function flashFloorRule(ruleId) {
    window.clearTimeout(floorFlashTimer);
    document.querySelectorAll(".floor-rule").forEach(function (rule) {
      rule.classList.toggle("is-invoked", rule.dataset.rule === ruleId);
    });
    dom.floorStatus.dataset.state = "refused";
    floorFlashTimer = window.setTimeout(function () {
      document.querySelectorAll(".floor-rule").forEach(function (rule) {
        rule.classList.remove("is-invoked");
      });
      dom.floorStatus.dataset.state = "intact";
    }, 2800);
  }

  function clearCapRefusals() {
    document.querySelectorAll(".cap-refusal").forEach(function (refusal) {
      refusal.hidden = true;
      refusal.replaceChildren();
    });
    document.querySelectorAll(".cap-row").forEach(function (row) {
      delete row.dataset.refused;
    });
  }

  function showCapRefusal(capId, code, message, ruleId) {
    clearCapRefusals();
    const row = document.querySelector('.cap-row[data-cap="' + capId + '"]');
    if (!row) {
      return;
    }
    const refusal = row.querySelector(".cap-refusal");
    const codeNode = document.createElement("span");
    codeNode.className = "refusal-code";
    codeNode.textContent = code;
    refusal.appendChild(codeNode);
    refusal.appendChild(document.createTextNode(" " + message));
    if (ruleId) {
      const ruleNode = document.createElement("span");
      ruleNode.className = "refusal-rule";
      ruleNode.textContent = floorRuleLabel(ruleId);
      refusal.appendChild(ruleNode);
    }
    refusal.hidden = false;
    row.dataset.refused = "true";
  }

  function recordFloorRefusal(code, rule, attempted) {
    state.lastFloorRefusal = { code: code, rule: rule, attempted: attempted };
    state.floorRefusals += 1;
    updateFloorStatus();
    flashFloorRule(rule);
  }

  function syncUI() {
    clearCapRefusals();
    CAPABILITIES.forEach(function (cap) {
      const admitted = state.caps[cap.id];
      const row = document.querySelector('.cap-row[data-cap="' + cap.id + '"]');
      const decision = document.getElementById("decision-" + cap.id);
      const toggle = row.querySelector(".switch");
      row.dataset.decision = admitted ? "allow" : "deny";
      decision.textContent = admitted ? "allow" : "deny";
      toggle.setAttribute("aria-checked", admitted ? "true" : "false");
    });
    updateActionGates();
    updateSignal();
    updateFloorStatus();
  }

  function updateActionGates() {
    dom.actions.forEach(function (button) {
      const actionId = button.dataset.action;
      const action = ACTIONS[actionId];
      const label = button.querySelector("[data-gate-label]");
      if (!action) {
        return;
      }

      if (actionId === "git_commit") {
        button.dataset.gateState = "human";
        label.textContent = "human approval only";
        return;
      }

      const gateId = action.capability;
      const open = Boolean(state.caps[gateId]);
      button.dataset.gateState = open ? "open" : "closed";
      label.textContent = GATE_NAMES[gateId] + (open ? " admitted" : " denied");
    });
  }

  function updateSignal() {
    setSignal("preflight", state.caps.preflight ? "open" : "closed", state.caps.preflight ? "allow" : "deny");
    setSignal("audit", state.caps.durableAudit ? "open" : "closed", state.caps.durableAudit ? "allow" : "deny");
    const effects = admittedEffects().length;
    setSignal(
      "effects",
      effects === 0 ? "closed" : effects === EFFECT_IDS.length ? "open" : "partial",
      effects + "/" + EFFECT_IDS.length
    );
    setSignal("floor", "open", "intact");
    setSignal("receipt", "live", "live");
  }

  function setSignal(name, stateValue, code) {
    const item = document.querySelector('[data-signal="' + name + '"]');
    if (!item) {
      return;
    }
    item.dataset.state = stateValue;
    const codeNode = item.querySelector("code");
    if (codeNode) {
      codeNode.textContent = code;
    }
  }

  /* ── Toggle handling ─────────────────────────────────────────────────── */

  function toggleCapability(capId) {
    const currently = Boolean(state.caps[capId]);

    if (capId === "preflight") {
      if (currently) {
        CAPABILITIES.forEach(function (cap) {
          state.caps[cap.id] = false;
        });
        syncUI();
        addBeat("gate.preflight", "deny", "preflight_suspended", "preflight");
        updateReceipt(
          "Preflight withdrawn. All six gates closed atomically; harnessReady false."
        );
      } else {
        state.caps.preflight = true;
        syncUI();
        addBeat("gate.preflight", "allow", "integrity_preflight_only", "preflight");
        updateReceipt(
          "Preflight admitted. Downstream gates remain closed until each is admitted."
        );
      }
      return;
    }

    if (!state.caps.preflight) {
      showCapRefusal(
        capId,
        "preflight_required",
        "Preflight is withdrawn. Re-admit the root gate before any downstream capability can be considered.",
        null
      );
      addBeat("gate." + capId, "deny", "preflight_required", capId);
      setReceiptLive(
        "Gate refused: preflight_required. Re-admit preflight before any downstream capability."
      );
      return;
    }

    if (capId === "durableAudit") {
      if (currently) {
        const effects = admittedEffects();
        if (effects.length > 0) {
          const names = effects
            .map(function (id) {
              return GATE_NAMES[id];
            })
            .join(", ");
          const message =
            "Cannot withdraw durable audit while " +
            names +
            (effects.length === 1 ? " is" : " are") +
            " admitted. That would leave admitted effects unrecorded, a silent fallback.";
          showCapRefusal(
            capId,
            "floor_audit_required_by_admitted_effects",
            message,
            "no_silent_fallback"
          );
          recordFloorRefusal(
            "floor_audit_required_by_admitted_effects",
            "no_silent_fallback",
            capId
          );
          addBeat("gate.durableAudit", "deny", "floor_audit_required_by_admitted_effects", capId);
          setReceiptLive(
            "Floor refusal: floor_audit_required_by_admitted_effects. " + message
          );
          return;
        }
        state.caps.durableAudit = false;
        syncUI();
        addBeat("gate.durableAudit", "deny", "audit_gate_closed", capId);
        updateReceipt(
          "Durable audit withdrawn. No effects are admitted, so the floor remains satisfied."
        );
        return;
      }

      state.caps.durableAudit = true;
      syncUI();
      addBeat("gate.durableAudit", "allow", "audit_gate_opened", capId);
      updateReceipt(
        "Durable audit admitted. Effect gates may now be admitted; every effect will have a record."
      );
      return;
    }

    if (!currently) {
      if (!state.caps.durableAudit) {
        const message =
          "Cannot admit " +
          GATE_NAMES[capId] +
          " while durable audit is denied. An effect without a durable beat would be a silent fallback. Admit durable audit first.";
        showCapRefusal(capId, "floor_effect_requires_audit", message, "no_silent_fallback");
        recordFloorRefusal("floor_effect_requires_audit", "no_silent_fallback", capId);
        addBeat("gate." + capId, "deny", "floor_effect_requires_audit", capId);
        setReceiptLive("Floor refusal: floor_effect_requires_audit. " + message);
        return;
      }
      state.caps[capId] = true;
      syncUI();
      addBeat("gate." + capId, "allow", "effect_gate_opened", capId);
      updateReceipt(
        GATE_NAMES[capId].charAt(0).toUpperCase() +
          GATE_NAMES[capId].slice(1) +
          " admitted. " +
          (allAdmitted()
            ? "All six gates are open in the model; harnessReady is true."
            : "The modeled receipt is not ready yet.")
      );
      return;
    }

    state.caps[capId] = false;
    syncUI();
    addBeat("gate." + capId, "deny", "effect_gate_closed", capId);
    updateReceipt(
      GATE_NAMES[capId].charAt(0).toUpperCase() +
        GATE_NAMES[capId].slice(1) +
        " withdrawn. The modeled receipt is no longer ready."
    );
  }

  /* ── Action gate ─────────────────────────────────────────────────────── */

  function evaluateAction(actionId) {
    const action = ACTIONS[actionId];

    if (!state.caps.preflight) {
      return {
        decision: "deny",
        code: "preflight_required",
        reason: ACTIONS.read_file.refusalReason,
        floorRule: null
      };
    }

    if (actionId === "git_commit") {
      const mutation = state.caps.repositoryMutation;
      return {
        decision: "deny",
        code: "human_commit_approval_required",
        reason: mutation
          ? "Repository mutation is admitted, but commit authority is not a capability. The no-auto-commit floor reserves commits to an explicit human act outside this gate."
          : "Repository mutation is denied, and commit would remain blocked anyway: the no-auto-commit floor reserves commit authority to an explicit human act. No capability toggle grants it.",
        floorRule: "no_auto_commit"
      };
    }

    if (actionId === "read_file") {
      return {
        decision: "allow",
        code: action.successCode,
        reason: action.successReason,
        floorRule: null
      };
    }

    if (!state.caps[action.capability]) {
      return {
        decision: "deny",
        code: action.refusalCode,
        reason: action.refusalReason,
        floorRule: null
      };
    }

    if (action.effect && !state.caps.durableAudit) {
      return {
        decision: "deny",
        code: "durable_audit_unadmitted",
        reason:
          "Durable audit is not admitted. The effect would be unrecorded, so the gate refuses it.",
        floorRule: null
      };
    }

    return {
      decision: "allow",
      code: action.successCode,
      reason: action.successReason,
      floorRule: null
    };
  }

  function runAction(actionId) {
    const result = evaluateAction(actionId);
    const beat = addBeat("action." + actionId, result.decision, result.code, actionId);

    dom.outcome.dataset.state = result.decision;
    dom.outcomeTarget.textContent = actionId;
    dom.outcomeDecision.textContent = result.decision;
    dom.outcomeCode.textContent = result.code;
    dom.outcomeReason.textContent = result.reason;
    dom.outcomeMeta.textContent =
      result.decision === "allow"
        ? "Simulated success · session beat #" + pad2(beat.n) + " · no engine effect"
        : "Typed refusal · session beat #" + pad2(beat.n) + " · no effect attempted" +
          (result.floorRule ? " · floor " + FLOOR_RULES[result.floorRule].code : "");

    if (result.floorRule) {
      recordFloorRefusal(result.code, result.floorRule, actionId);
    }
  }

  /* ── Session beats ───────────────────────────────────────────────────── */

  function addBeat(event, decision, code, subject) {
    beatSeq += 1;
    const beat = {
      n: beatSeq,
      time: timeNow(),
      event: event,
      decision: decision,
      code: code,
      subject: subject
    };
    beats.unshift(beat);
    beats = beats.slice(0, 30);
    renderBeats();
    return beat;
  }

  function renderBeats() {
    dom.beatCount.textContent = String(beatSeq);
    dom.beatList.replaceChildren();

    if (beats.length === 0) {
      const empty = document.createElement("li");
      empty.className = "beat-empty";
      empty.textContent = "No beats recorded. Try an action or a gate.";
      dom.beatList.appendChild(empty);
      return;
    }

    beats.slice(0, 8).forEach(function (beat) {
      const item = document.createElement("li");
      item.className = "beat";

      const meta = document.createElement("span");
      meta.className = "beat-meta";
      meta.textContent = "#" + pad2(beat.n) + " · " + beat.time + " · session";

      const line = document.createElement("span");
      line.className = "beat-line";

      const event = document.createElement("span");
      event.className = "beat-event";
      event.textContent = beat.event;

      const decision = document.createElement("span");
      decision.className = "beat-decision";
      decision.dataset.decision = beat.decision;
      decision.textContent = beat.decision;

      const code = document.createElement("code");
      code.className = "beat-code";
      code.textContent = beat.code;

      line.appendChild(event);
      line.appendChild(decision);
      line.appendChild(code);
      item.appendChild(meta);
      item.appendChild(line);
      dom.beatList.appendChild(item);
    });
  }

  /* ── Reset and copy ──────────────────────────────────────────────────── */

  function resetOutcome() {
    dom.outcome.dataset.state = "idle";
    dom.outcomeTarget.textContent = "awaiting action";
    dom.outcomeDecision.textContent = "idle";
    dom.outcomeCode.textContent = "—";
    dom.outcomeReason.textContent =
      "Choose an action above. The gate will return either a typed refusal or a simulated success with a recorded beat.";
    dom.outcomeMeta.textContent = "No beat recorded.";
  }

  function resetLab() {
    state.caps = Object.assign({}, INITIAL_CAPS);
    state.lastFloorRefusal = null;
    state.floorRefusals = 0;
    beats = [];
    beatSeq = 0;

    window.clearTimeout(floorFlashTimer);
    dom.floorStatus.dataset.state = "intact";
    document.querySelectorAll(".floor-rule").forEach(function (rule) {
      rule.classList.remove("is-invoked");
    });

    resetOutcome();
    renderBeats();
    syncUI();
    updateReceipt("Lab reset to the initial posture: preflight admitted; five gates denied.");

    window.clearTimeout(copyTimer);
    dom.copyButton.dataset.copied = "false";
    dom.copyButton.dataset.error = "false";
    dom.copyLabel.textContent = "Copy receipt";
    if (dom.copyStatus) {
      dom.copyStatus.textContent = "";
    }
  }

  async function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        /* Fall through to the selection-based copy. */
      }
    }

    const active = document.activeElement;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.left = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    }
    area.remove();

    if (active && typeof active.focus === "function") {
      active.focus({ preventScroll: true });
    }
    return copied;
  }

  function setCopyStatus(text) {
    if (dom.copyStatus) {
      dom.copyStatus.textContent = text;
    }
  }

  async function copyReceipt() {
    if (!currentReceipt) {
      return;
    }
    window.clearTimeout(copyTimer);
    const copied = await writeClipboard(currentReceipt.text + "\n");

    dom.copyButton.dataset.copied = copied ? "true" : "false";
    dom.copyButton.dataset.error = copied ? "false" : "true";
    dom.copyLabel.textContent = copied ? "Copied" : "Copy failed";
    setCopyStatus(
      copied
        ? "Receipt copied to the clipboard."
        : "Copy failed. Select the receipt text and copy it manually."
    );

    copyTimer = window.setTimeout(function () {
      dom.copyButton.dataset.copied = "false";
      dom.copyButton.dataset.error = "false";
      dom.copyLabel.textContent = "Copy receipt";
    }, copied ? 1800 : 2800);
  }

  /* ── Wiring ──────────────────────────────────────────────────────────── */

  function bindEvents() {
    dom.switches.forEach(function (toggle) {
      toggle.addEventListener("click", function () {
        const row = toggle.closest(".cap-row");
        if (row) {
          toggleCapability(row.dataset.cap);
        }
      });
    });

    dom.actions.forEach(function (button) {
      button.addEventListener("click", function () {
        runAction(button.dataset.action);
      });
    });

    dom.copyButton.addEventListener("click", copyReceipt);
    dom.reset.addEventListener("click", resetLab);
  }

  function init() {
    cacheDom();
    bindEvents();
    syncUI();
    renderBeats();
    resetOutcome();
    updateReceipt();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
