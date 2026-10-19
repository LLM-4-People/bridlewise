---
layout: default
title: "Bridlewise — every run, recorded. Every tool, governed."
description: "A local-first, experimental coding cockpit. The repository is a run record: eight beats from intent to release, with governed tools and visible limits."
permalink: /
page_class: home
---

<section class="hero">
  <p class="eyebrow">Developer preview <span class="dot" aria-hidden="true"></span> Pre-admission <span class="dot" aria-hidden="true"></span> AGPL-3.0</p>
  <h1>Every run, recorded.<br><span class="beam-text">Every tool, governed.</span></h1>
  <p class="lede">Bridlewise is a coding cockpit you run on your own machine. A conversation becomes a run: a recorded causal stream of model turns, tool calls, file effects, checks, and findings — with the tool surface gated before and during execution. The repository is its flight recorder.</p>
  <div class="actions">
    <a class="button primary" href="{{ '/quickstart/' | relative_url }}">Start with a disposable copy</a>
    <a class="button" href="{{ '/run/' | relative_url }}">Open the run record</a>
    <a class="button" href="https://github.com/LLM-4-People/bridlewise">Read the source</a>
  </div>
  <p class="hero-note">Node 24 · Linux first · loopback only · SQLite · no hosted service</p>

  <figure class="hero-figure">
    <img src="{{ '/assets/hero.png' | relative_url }}" alt="The Bridlewise cockpit: a run rendered as a causal stream of turns, tool calls, file effects, checks, and findings">
    <figcaption>A recorded run in the cockpit: causal beats, the tool surface, and the composer.</figcaption>
  </figure>
</section>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">The flight recorder</p>
    <h2>A run has eight beats. The repository keeps them.</h2>
  </div>
  <div class="prose">
    <p>Most coding agents leave the interesting part in a provider's logs: which tool was called, what it changed, which check moved, and what the system decided not to allow. Bridlewise makes that part the primary surface. A run executes once, persists its stream, and can be reopened without starting a second execution.</p>
    <p>The same sequence describes the project's own public record. Intent becomes a README; boundary becomes a security policy; tool becomes a workflow; effect becomes a release; check becomes CI; finding becomes an issue; decision becomes a discussion or a decision record; release becomes the artifact you can inspect.</p>
  </div>

  <div class="prose">
    <table>
      <thead>
        <tr><th>Beat</th><th>What the record holds</th></tr>
      </thead>
      <tbody>
        <tr><td><strong>1 · Intent</strong></td><td>The prompt, project, model, and plan — what the run is trying to do.</td></tr>
        <tr><td><strong>2 · Boundary</strong></td><td>The provider, tool registry, policy, project root, and confinement decision.</td></tr>
        <tr><td><strong>3 · Tool</strong></td><td>The registered tool, typed arguments, and the pre-dispatch gate's answer.</td></tr>
        <tr><td><strong>4 · Effect</strong></td><td>A file diff, command result, or process effect — with a rollback handle where one exists.</td></tr>
        <tr><td><strong>5 · Check</strong></td><td>The check, its before-and-after state, and the delta that actually moved.</td></tr>
        <tr><td><strong>6 · Finding</strong></td><td>What a check or detector found, with its source and derivation.</td></tr>
        <tr><td><strong>7 · Decision</strong></td><td>Allow, deny, stop, retry, or escalate — including the typed refusals.</td></tr>
        <tr><td><strong>8 · Release</strong></td><td>What leaves the harness: a diff, a report, a commit, or a published artifact.</td></tr>
      </tbody>
    </table>
    <p><a href="{{ '/github/' | relative_url }}">See how each beat maps to a GitHub surface →</a> · <a href="{{ '/glossary/' | relative_url }}">Keep the vocabulary sharp →</a></p>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">Three doors</p>
    <h2>Run it. Read the record. Audit the limits.</h2>
    <p class="section-lede">Pick the door that matches what you need to know. None of them requires trusting the marketing copy.</p>
  </div>
  <div class="feature-grid">
    <article class="feature">
      <p class="feature-kicker">01 · Run it</p>
      <h3>Start on a disposable copy</h3>
      <p>Node 24, a provider you can revoke, and a repository you can lose. The quickstart is explicit about the config mode, the ports, and the first account.</p>
      <p><a href="{{ '/quickstart/' | relative_url }}">Quickstart</a> · <a href="{{ '/cli/' | relative_url }}">CLI reference</a> · <a href="{{ '/codespaces/' | relative_url }}">Codespace</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">02 · Read the record</p>
      <h3>Inspect a run, then the project</h3>
      <p>The interactive run is a synthetic record you can explore. The GitHub map shows how the project records its own checks, findings, and releases.</p>
      <p><a href="{{ '/run/' | relative_url }}">Interactive run</a> · <a href="{{ '/policy-lab/' | relative_url }}">Policy lab</a> · <a href="{{ '/github/' | relative_url }}">GitHub map</a> · <a href="{{ '/evidence/' | relative_url }}">Evidence</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">03 · Audit the limits</p>
      <h3>Read what is not proven</h3>
      <p>The threat model, the gap register, and a reading map that goes from 90 seconds to a security review. The warning is part of the product.</p>
      <p><a href="{{ '/security/' | relative_url }}">Security and limits</a> · <a href="{{ '/known-issues/' | relative_url }}">Known issues</a> · <a href="{{ '/reading-map/' | relative_url }}">Reading map</a></p>
    </article>
  </div>
</section>

<section class="section section-wide">
  <div class="section-head">
    <p class="eyebrow">Two instruments, clearly labeled</p>
    <h2>Don't just read the claim. Move through the record.</h2>
    <p class="section-lede">Both pages are interactive, self-contained illustrations. Neither calls a model, executes a tool, or changes a real policy. That is the point: you can inspect the shape before you install anything.</p>
  </div>
  <div class="feature-grid">
    <article class="feature">
      <p class="feature-kicker">Instrument 01 · The flight recorder</p>
      <h3>Run 0001: trace the request boundary</h3>
      <p>Move through eight beats — intent, model turn, governed tool, file effect, check, finding, refusal, release. Follow cause to effect, inspect the evidence, and see where a redaction happened.</p>
      <p><a href="{{ '/run/' | relative_url }}">Enter the run record →</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">Instrument 02 · The governance console</p>
      <h3>Flip a capability. Watch the receipt refuse.</h3>
      <p>Toggle capabilities, try an action, and read the typed refusal. The safety floor cannot be toggled. The real engine's policy is code, not this console; the console makes the posture legible.</p>
      <p><a href="{{ '/policy-lab/' | relative_url }}">Open the policy lab →</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">Instrument 03 · The repository</p>
      <h3>The project is a run record too.</h3>
      <p>Actions are checks. Security is custody. Releases are effects. Issues are findings. The GitHub map names what each surface proves — and what it does not.</p>
      <p><a href="{{ '/github/' | relative_url }}">Read the GitHub map →</a></p>
    </article>
  </div>

  <div class="screenshot-grid">
    <figure class="screenshot">
      <img src="{{ '/assets/run-record-preview.png' | relative_url }}" alt="The illustrative Run 0001 record, with a causal timeline of eight beats and an inspector showing a file effect">
      <figcaption><strong>RUN 0001.</strong> A synthetic record with a causal timeline, evidence inspector, typed refusal, and a redaction. <a href="{{ '/run/' | relative_url }}">Open it →</a></figcaption>
    </figure>
    <figure class="screenshot">
      <img src="{{ '/assets/policy-lab-preview.png' | relative_url }}" alt="The illustrative governance lab, showing capability gates, a preflight receipt, action probes, and the immutable safety floor">
      <figcaption><strong>POLICY LAB.</strong> Six gates, one floor. Flip a capability and watch the receipt refuse. <a href="{{ '/policy-lab/' | relative_url }}">Open it →</a></figcaption>
    </figure>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">What is in the tree</p>
    <h2>Small surface, real machinery.</h2>
  </div>
  <div class="feature-grid">
    <article class="feature">
      <p class="feature-kicker">01 · Provenance</p>
      <h3>A causal run stream</h3>
      <p>Turns, tool beats, effects, checks, and findings in one ordered record. A second viewer reads the record; it does not fork the run.</p>
    </article>
    <article class="feature">
      <p class="feature-kicker">02 · Governance</p>
      <h3>Typed blockers, no silent fallback</h3>
      <p>An unconfigured adapter names what is missing. A ghost tool is refused before dispatch. A blocked action stays blocked; it does not become a plausible substitute.</p>
    </article>
    <article class="feature">
      <p class="feature-kicker">03 · Safety</p>
      <h3>Gates before and during the turn</h3>
      <p>Pre-dispatch schema and loop checks, streaming bias and deviation detectors, an artifact sandbox check, and Landlock confinement for shell commands on Linux.</p>
    </article>
    <article class="feature">
      <p class="feature-kicker">04 · Locality</p>
      <h3>Your machine is the boundary</h3>
      <p>The server binds to <code>127.0.0.1</code>. State is local SQLite. Sensitive fields are encrypted, and database keys live outside every checkout.</p>
    </article>
  </div>
</section>

<section class="section section-wide">
  <div class="section-head">
    <p class="eyebrow">The cockpit</p>
    <h2>Instrument glass over a paper logbook.</h2>
    <p class="section-lede">Carbon dark grounds, engraved labels, one live beam for what is actually happening, and a light logbook theme that reads like paper. The design is documented, not decorative.</p>
  </div>

  <div class="screenshot-grid">
    <figure class="screenshot">
      <img src="{{ '/assets/cockpit-flow.png' | relative_url }}" alt="The FLOW shows a run as typed beats with visible verbs and causal connections">
      <figcaption><strong>FLOW.</strong> The run, full-bleed. Prose at a readable measure; instruments across the width.</figcaption>
    </figure>
    <figure class="screenshot">
      <img src="{{ '/assets/cockpit-switch.png' | relative_url }}" alt="The switch shows projects and recent conversations with measured outcomes">
      <figcaption><strong>SWITCH.</strong> The recency river of projects and conversations, with measured outcomes.</figcaption>
    </figure>
    <figure class="screenshot">
      <img src="{{ '/assets/cockpit-instruments.png' | relative_url }}" alt="The Instruments room lists measured signals with their actions">
      <figcaption><strong>INSTRUMENTS.</strong> Measured values, honest absence, and the verb attached to each fact.</figcaption>
    </figure>
    <figure class="screenshot">
      <img src="{{ '/assets/cockpit-settings.png' | relative_url }}" alt="The settings room indexes settings with their current values">
      <figcaption><strong>SETTINGS.</strong> One searchable index; the value and its commit action stay together.</figcaption>
    </figure>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">Before you run it</p>
    <h2>This is a preview, not a product.</h2>
  </div>
  <div class="callout warning">
    <p><strong>Do not use Bridlewise on proprietary, regulated, client-confidential, or production code.</strong> The engine is pre-admission: <code>harnessReady</code> is <code>false</code>, interactive capabilities remain behind an open governance gate, and there has been no security audit. Expect breaking changes and data loss. Run on a disposable copy, with revocable credentials and your own backups.</p>
    <p><a href="{{ '/security/' | relative_url }}">Read the threat model and the limits →</a></p>
  </div>
</section>

<section class="section cta">
  <p class="eyebrow">Take it for a spin — carefully</p>
  <h2>Clone it. Read the record. Tell us what breaks.</h2>
  <p>Install with Node 24, start the loopback server, create the first account, and point it at a disposable repository. If the evidence does not match the claim, that is a bug worth reporting.</p>
  <div class="actions">
    <a class="button primary" href="{{ '/quickstart/' | relative_url }}">Quickstart</a>
    <a class="button" href="{{ '/github/' | relative_url }}">The repository as a run record</a>
    <a class="button" href="{{ '/known-issues/' | relative_url }}">Known issues</a>
    <a class="button" href="https://github.com/LLM-4-People/bridlewise-testing">Development floor</a>
  </div>
</section>
