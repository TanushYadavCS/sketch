---
name: technical-explainer
description: Build a self-contained HTML explainer that makes a hard part of the codebase understandable to someone who has not read it — a pipeline, a subsystem, an access model, a plan and why it changed. Use when asked to "explain this", "help me understand what's going on", "walk me through how X works", "write this up for the team", or when the same person has now asked about the same thing twice. Not for PDFs (md-to-pdf, canvas-pdf), decks (pptx, canvas-deck), or a page published to a URL (Artifact).
---

# Technical Explainer

Produces one HTML file that explains something hard to a reader who does not have the
context you have. It gets committed next to the code or the plan it describes, and it
stays useful six months later when nobody remembers the decision.

One file. All CSS inlined. No build step, no dependencies. Double-click it from disk.

The value is not the CSS — it is the discipline below. A beautiful document built from
assumption is worse than no document, because it gets believed.

## When it earns its cost

- A subsystem someone must understand before they can safely change it.
- A pipeline with stages, where the drop-off between stages is the point.
- A plan that changed direction, where *why* it changed is the valuable part.
- A rule with several branches — permissions, routing, a state machine.
- Anything the same person has asked about twice. The second question is the trigger.

Not this: a short answer (write two paragraphs in chat), API reference (this is a
narrative, not a manual), or anything that must live at a URL for people outside the
repo (Artifact tool).

## Build order

1. **Get the facts first.** Read the code. Run the queries. Get the real counts. Do not
   write a line until you could defend every number.
2. **Draw the diagram before the prose.** If you cannot get the shape into 4–8 boxes,
   you do not understand it well enough to explain it yet. That failure is information —
   go back to step 1.
3. **Fill sections in the order a reader needs them**, not the order you learned them.
4. **Re-read only the bold text and the callouts.** They must tell the whole story alone.
   Most readers will read nothing else.

## The writing rules

These are what make it good.

**Short sentences. One idea each.** Two clauses joined by "and" is usually two sentences.

**Everyday words.** If a term is unavoidable, define it in about four words inline and
move on. Never define a term you then do not use.

**Lead with the answer.** Every section opens with its conclusion. No "in order to
understand X we must first consider Y".

**Real numbers, always.** "Most users" is worthless. "3,121 of 3,801 files" is the whole
point. Every number must come from something you actually ran — a query, a test, a grep.
If you could not measure it, say so plainly rather than reaching for a vague quantifier.

**Point at the code.** Use the `.where` chip for `path/to/file.ts:123 · functionName` so
a sceptical reader can check you. An explainer that cannot be verified will not be
trusted by the person who most needs it.

**Explain each snippet in words underneath.** A snippet with no plain-English line under
it helps only the people who already understood.

**Say what is broken, including your own mistakes.** Often the most valuable line is
"I got this wrong the first time, here is what I missed." It tells the reader which
parts are load-bearing and stops the next person repeating it. This is also the line
people quote back to you months later.

**Never flatter the design.** If something is confusing, say it is confusing. If a
feature surprises people, that is a callout, not a footnote. No "powerful", "seamless",
"robust" — describe the mechanism instead.

## Structure

| Part | Job |
|---|---|
| `h1` + `.sub` | The real subject in one sentence a newcomer parses |
| `.meta` | repo · path · branch @ commit — so the reader knows what it describes |
| `.diagram` | The whole shape, before any detail |
| `01…0N` sections | One idea each |
| Final section | Where it stands, what is still open |
| `.meta` footer | Pointers to the full detail |

Numbered `<h2>`s let people say "section 3" in Slack. Worth keeping.

## Components, and what each is for

- **`.diagram`** — steps in order. `.lane` labels a group with a different lifetime
  ("runs on a timer" vs "separate loop"). `.arrow small` carries drop-off between steps
  (`~5 users left out of 49`). `.blk.dead` (dashed, faded) marks a step that exists in
  the code but never fires — usually one of the most useful things you can show.
- **`.note`** — one thing they must not miss. Bold lead, then the fact. `.note.bad` for a
  real problem, `.note.ok` for a confirmed-good result. Three or four per document at
  most; more and they stop registering.
- **`table`** — facts with a shape. `td.k` for measured values in mono, `td.z` when the
  number *is* the problem (renders red). A column of zeros in red says more than a
  paragraph.
- **`pre`** — real code, copied not paraphrased. `.c` for comments, `.x` for the broken
  line. Marking the one bad line in red beats explaining it.
- **`.pr`** — stacked cards for options, phases, or alternatives being compared.

## Design tokens

| Token | Value | Use |
|---|---|---|
| `--ink` | `#14130e` | Headings, strong text |
| `--body` | `#33322a` | Body copy |
| `--muted` | `#6f6e64` | Secondary text, descriptions |
| `--faint` | `#8a8880` | Numbers, labels, captions |
| `--line` | `#e4e2da` | Every border and rule |
| `--card` | `#faf9f6` | Diagram, callout, card backgrounds |
| `--code` | `#f4f3ee` | Code blocks, inline code |
| `--page` | `#fff` | Page background |
| `--bad` | `#8c2f1d` | Only for a broken/zero/failing value |
| `--ok` | `#2f5d3a` | Only for a confirmed-good value |

**Inter** for prose, **JetBrains Mono** for anything a reader might paste into a terminal
— paths, counts, identifiers, commits. Both from Google Fonts; the file degrades to
system fonts offline and stays readable. Drop the `<link>` if it must work fully offline.

Body caps at `880px` because line length is the main readability lever. One column, no
sidebars, nothing that reflows badly when printed or opened on a phone.

**Restraint is the aesthetic.** Warm off-white, near-black ink, one accent for broken and
one for good. Colour carries meaning here — if everything is coloured, nothing is. Do not
add brand colours, gradients, logos, or a second typeface.

## Where the file goes

Next to what it explains, in version control. A plan → the same folder as the plan. A
subsystem → `docs/` in that package. Throwaway → a scratch directory.

Cross-link both ways: a line in the plan pointing at the explainer, a line in the
explainer pointing back. One nobody can find is one nobody reads.

## Anti-patterns

- **Writing before reading the code.** Produces confident, wrong, believed prose.
- **Editing the CSS rules.** The tokens are the system. Editing rules creates drift
  between documents that should look identical.
- **Fifteen boxes in the diagram.** That is two documents, or one diagram plus a table.
- **Hedging.** "Some files could potentially be visible" helps nobody. Either it is, or
  it is not, or you did not check — say which.
- **Skipping a number because measuring it would take a detour.** Take the detour. That
  is most of the value.

## Template

Copy this to the target path and edit it down. Everything needed is in it.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TITLE — short subject line</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  /* DESIGN TOKENS — change these, not the rules below. */
  :root {
    --ink:#14130e; --body:#33322a; --muted:#6f6e64; --faint:#8a8880;
    --line:#e4e2da; --card:#faf9f6; --code:#f4f3ee; --page:#fff;
    --bad:#8c2f1d; --ok:#2f5d3a;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family:"Inter",system-ui,sans-serif; background:var(--page); color:var(--body);
    line-height:1.6; -webkit-font-smoothing:antialiased;
    max-width:880px; margin:0 auto; padding:56px 28px 120px;
  }

  h1 { font-size:30px; font-weight:700; color:var(--ink); letter-spacing:-.02em; line-height:1.2; }
  .sub { color:var(--muted); font-size:16px; margin-top:10px; }
  .meta { font-family:"JetBrains Mono",monospace; font-size:12px; color:var(--faint); margin-top:14px; }

  h2 { font-size:20px; font-weight:700; color:var(--ink); margin:52px 0 6px; letter-spacing:-.01em; }
  h2 .n { font-family:"JetBrains Mono",monospace; font-size:14px; color:var(--faint); margin-right:10px; }
  h3 { font-size:14px; font-weight:600; color:var(--ink); margin:22px 0 8px; }
  p { margin:10px 0; font-size:15.5px; }
  hr { border:0; border-top:1px solid var(--line); margin:0; }

  /* file:line chip — "go and check me" */
  .where { font-family:"JetBrains Mono",monospace; font-size:12.5px; color:var(--muted);
           background:var(--code); border-radius:5px; padding:3px 8px; display:inline-block; margin-top:4px; }

  /* block diagram */
  .diagram { margin:36px 0 8px; border:1px solid var(--line); border-radius:12px; padding:26px 22px; background:var(--card); }
  .blk { border:1px solid var(--line); background:var(--page); border-radius:9px; padding:13px 16px; display:flex; gap:14px; align-items:baseline; }
  .blk .bn { font-family:"JetBrains Mono",monospace; font-size:12px; color:var(--faint); flex:0 0 18px; }
  .blk .bt { font-weight:600; color:var(--ink); font-size:15px; flex:0 0 190px; }
  .blk .bd { font-size:13.5px; color:var(--muted); }
  .blk.dead { opacity:.55; border-style:dashed; }   /* exists in code, never fires */
  .arrow { text-align:center; color:var(--faint); font-size:15px; line-height:1; margin:5px 0; }
  .arrow small { font-family:"JetBrains Mono",monospace; font-size:10.5px; letter-spacing:.06em; margin-left:8px; color:var(--faint); }
  .gap { height:14px; }
  .lane { font-family:"JetBrains Mono",monospace; font-size:10.5px; letter-spacing:.11em;
          text-transform:uppercase; color:var(--faint); margin:16px 0 8px; }

  pre { background:var(--code); border:1px solid var(--line); border-radius:8px; padding:15px 17px;
        overflow-x:auto; font-family:"JetBrains Mono",monospace; font-size:12.5px; line-height:1.65;
        color:var(--ink); margin:12px 0; white-space:pre; }
  pre .c { color:var(--faint); }                 /* comment */
  pre .x { color:var(--bad); font-weight:500; }  /* the broken line */
  code { font-family:"JetBrains Mono",monospace; font-size:13px; background:var(--code);
         padding:1px 5px; border-radius:4px; color:var(--ink); }

  .note { border-left:3px solid var(--ink); background:var(--card); padding:12px 16px;
          border-radius:0 8px 8px 0; margin:16px 0; font-size:14.5px; }
  .note b { color:var(--ink); }
  .note.bad { border-left-color:var(--bad); }
  .note.ok  { border-left-color:var(--ok); }

  ul { margin:10px 0 10px 20px; } li { margin:5px 0; font-size:15px; }
  table { border-collapse:collapse; width:100%; margin:14px 0; font-size:14px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); font-weight:600; }
  td.k { font-family:"JetBrains Mono",monospace; font-size:12.5px; color:var(--ink); white-space:nowrap; }
  td.z { font-family:"JetBrains Mono",monospace; font-size:12.5px; color:var(--bad); font-weight:500; }

  .pr { border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:12px 0; background:var(--card); }
  .pr .t { font-weight:700; color:var(--ink); font-size:15.5px; }
  .pr .s { font-family:"JetBrains Mono",monospace; font-size:11px; color:var(--faint);
           text-transform:uppercase; letter-spacing:.08em; margin-bottom:4px; }
</style>
</head>
<body>

<h1>The thing, stated plainly</h1>
<p class="sub">One sentence a newcomer understands, naming the real problem.</p>
<p class="meta">repo · path/to/the/code · branch @ commit</p>

<div class="diagram">
  <div class="lane">What runs, in order</div>
  <div class="blk"><span class="bn">1</span><span class="bt">Short verb phrase</span><span class="bd">What it does, in everyday words.</span></div>
  <div class="arrow">↓ <small>optional: what survives this step</small></div>
  <div class="blk"><span class="bn">2</span><span class="bt">Short verb phrase</span><span class="bd">What it does.</span></div>
  <div class="arrow">↓</div>
  <div class="blk dead"><span class="bn">3</span><span class="bt">Never fires today</span><span class="bd">Dashed + faded = in the code, unreachable in practice.</span></div>

  <div class="gap"></div>
  <div class="lane">Separate loop — different lifetime</div>
  <div class="arrow">↓</div>
  <div class="blk"><span class="bn">4</span><span class="bt">Runs later</span><span class="bd">And never reports back to steps 1–3.</span></div>
</div>
<p style="font-size:14px;color:var(--muted)">One line for what the boxes cannot show.</p>

<hr style="margin-top:40px" />

<h2><span class="n">01</span>First real section</h2>
<p>Short sentences. One idea each.</p>
<p><span class="where">path/to/file.ts:123 · functionName</span></p>
<pre>const guarded = emails.length &gt; 0 ? withEmail : plain;   <span class="c">// guarded ✓</span>
eb.or([ ..., eb("table.column", "is not", null) ]);      <span class="x">// NOT guarded ✗</span></pre>
<p>Then one sentence saying what that means in plain terms.</p>

<div class="note"><b>Lead with the point in bold.</b> Then the supporting fact, with a real number in it.</div>

<h2><span class="n">02</span>A section carrying facts</h2>
<table>
  <tr><th>Thing</th><th>Count</th><th>So what</th></tr>
  <tr><td>Normal row</td><td class="k">16,886</td><td>Mono for anything measured.</td></tr>
  <tr><td>Broken row</td><td class="z">0</td><td>Red mono when the number is the problem.</td></tr>
</table>

<div class="note bad"><b>The uncomfortable finding.</b> Say it straight, including if it was your own mistake.</div>

<h2><span class="n">03</span>Options or phases</h2>
<div class="pr">
  <div class="s">Phase A · ships first</div>
  <div class="t">What it does, as a claim not a label.</div>
  <p style="margin:6px 0 0">Why it is first, in two sentences.</p>
</div>

<h2><span class="n">04</span>Where this stands</h2>
<ul>
  <li>What is true now.</li>
  <li>What is still open, and who decides.</li>
</ul>

<p class="meta" style="margin-top:38px">Full detail: path/to/the/plan.md · Related: OTHER_DOC.md</p>

</body>
</html>
```
