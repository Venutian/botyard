# Plan: free runs hand over before the context fills (NGE-3373, IMP-109)

Goal: a free run never dies on context overflow after burning tokens. Week evidence (waste.json): Fred 64/523 runs wasted (32.9M tokens), Freya 34/325 (16.2M); "exceeds the model maximum context length of 262144" hit Fred 17x, Freya 11x; 24 more "Too Many Requests" for Fred.
Code: crew/free-runner.py (Loops.feed ~112, CONTEXT ~194, context_error ~353, main loop 700-949, without_session ~594, with_model ~610). Tests live in crew/tests/ (see test_long_run_notice.py for a fake-opencode pattern).

## Limits
- Model max context 262144 tokens; handover limit 200000 as a named constant CONTEXT_HANDOVER, per-model override table where the max is known.
- Below the limit nothing changes; the handover fires once per session; no existing test is edited to pass.

## Step 1: Track context size and hand over
- Outcome: the runner reads the session's context size from OpenCode step_finish events (part.tokens: input, output, reasoning, cache read/write; verify the real field names from a recent run log before coding). Past the limit at a step end, the run stops cleanly, the model is asked once for a short state (done, left, files touched), and the state is posted as a comment on the job.
- Builder: grade haiku
- Files: crew/free-runner.py (new constant, a small context-tracking helper, hook in the event loop near line 804). Must not change Loops circle detection, the 429 path or the notice logic.
- PROOF: python3 -m pytest crew/tests/test_free_handover.py -k "track or handover_once or below_limit" run by Freya; below 200k no change, a stream passing 200k triggers exactly one handover.
- Depends on: none
- Job: J1

## Step 2: Resume in a fresh session, also after a context error
- Outcome: after the handover, the run restarts with no --session (without_session) and a prompt that begins with the state comment; the next model is chosen as today. When context_error fires, the run also starts a fresh session with that state (or the original prompt plus a note if no state exists), never the same oversized session.
- Builder: grade haiku
- Files: crew/free-runner.py main loop (switch-model branch near line 907 and the handover branch); must not change other switch reasons (loop, 429, outage keep the same session).
- PROOF: python3 -m pytest crew/tests/test_free_handover.py -k "fresh_session or context_error or state_comment" run by Freya; plus python3 -m pytest crew/tests -q passes with the same passes as before plus the new ones.
- Depends on: 1
- Job: J1

## Step 3: Check the 429 path does not waste tokens
- Outcome: a written finding in the job report: does a retry or rest on 429 resend the full session more than needed? Fix only if clearly wasteful; otherwise change nothing.
- Builder: grade haiku
- Files: crew/free-runner.py (BUSY_WORDS, guards.RETRY_WAITS use at ~871-900) and crew/guards.py; read-only unless a fix is clearly needed, then with a test.
- PROOF: python3 -m pytest crew/tests -q passes; any fix has a test in test_free_handover.py; Freya reads the finding against the code.
- Depends on: 2
- Job: J1

## Measure after a week
Script check: waste.json context-error counts for Fred and Freya go to about 0. Read by Tony, not the builder.

## Re-plan rule
- When a step ends NOT MET twice, the next job is not a third try: it is a redesign brief for that step, written for the matching lead: game-designer (a mechanic or loop), systems-designer (numbers, balance, formulas), ux-designer (a screen, flow or readability), art-director (look, assets, style). Pick the one the failure is about.
- When the redesign step also ends NOT MET, stop building: write a ruling file for Gideon with ruling.py (the step, both failures, the options and what each costs) and start nothing else on that step until he rules.
- Where the goal names limits, they are under "## Limits" and every step's PROOF measures them.
