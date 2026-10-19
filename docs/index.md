---
layout: default
title: "Bridlewise — every run, recorded. Every tool, governed."
description: "A local-first, experimental coding cockpit. Runs are recorded as causal streams; tools are governed, checked, and confined on Linux."
permalink: /
page_class: home
---

<section class="hero">
  <p class="eyebrow">Developer preview <span class="dot" aria-hidden="true"></span> Pre-admission <span class="dot" aria-hidden="true"></span> AGPL-3.0</p>
  <h1>Every run, recorded.<br><span class="beam-text">Every tool, governed.</span></h1>
  <p class="lede">Bridlewise is a coding cockpit you run on your own machine. A conversation becomes a run: a recorded causal stream of model turns, tool calls, file effects, checks, and findings — with the tool surface gated before and during execution.</p>
  <div class="actions">
    <a class="button primary" href="{{ '/quickstart/' | relative_url }}">Start with a disposable copy</a>
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
    <p class="eyebrow">Why this exists</p>
    <h2>The chat is a view. The run is the thing.</h2>
  </div>
  <div class="prose">
    <p>Most coding agents present a conversation and leave the interesting part in a provider's logs: which tool was called, with what arguments, what it changed, which check moved, and what the system decided not to allow. Bridlewise makes that part the primary surface.</p>
    <p>A run executes once. Its stream is persisted as an ordered, append-only timeline of typed beats. Reopening the stream attaches to the recorded execution instead of starting another one. The cockpit renders the causal edge — tool input to output, edit to diff, check to delta, detection to response — so the record can be inspected rather than inferred.</p>
    <p>That design makes different demands on the harness: a governed tool registry, explicit blockers, pre-dispatch and runtime checks, transactional edits, and a local trust boundary. Those are the parts Bridlewise spends its complexity on. The interface is the instrument panel over that machinery.</p>
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
      <p class="feature-kicker">04 · Understanding</p>
      <h3>Code intelligence, not grep</h3>
      <p>Repository maps, symbol search, dependency graphs with cycles, data flow, reuse discovery, and AST-accurate slices, backed by tree-sitter.</p>
    </article>
    <article class="feature">
      <p class="feature-kicker">05 · Editing</p>
      <h3>A transactional editor</h3>
      <p>One <code>edit</code> tool plans, applies, and validates exact replacements. Diffs are reviewable; edits can be rolled back.</p>
    </article>
    <article class="feature">
      <p class="feature-kicker">06 · Locality</p>
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
    <a class="button" href="{{ '/architecture/' | relative_url }}">Architecture</a>
    <a class="button" href="https://github.com/LLM-4-People/bridlewise-testing">Development floor</a>
  </div>
</section>
