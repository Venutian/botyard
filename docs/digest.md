# The decision digest: one short list instead of a stream of cards

A bot that needs the owner leaves a card. Left alone, cards pile up: the same question three times, a
yes that could have been assumed, and the two that really matter somewhere in between. The digest is
what the owner sees instead.

## Two kinds of card

Every card gets a kind when it is made (`studio/server/engine/card-kind.mjs`):

- **must** — only the owner answers it, however long it waits:
  - it spends money;
  - it deletes work that is not merged;
  - it is a store release;
  - it is final art;
  - it needs the owner's sign-in;
  - the engine could not take its answer back (a gate whose yes starts a script, such as a landing);
  - it names no default answer;
  - the bot, or the owner by taking a default back, said so.
- **default** — everything else. It carries the answer the bot would choose.

The five subjects are found in the card's own words (title, question, options), so a card about paying
for something is `must` whatever else it says. When in doubt a card is `must`.

## The default answer

- A question card names it per question: `"default": "<option id>"` on the question, `"recommended":
  true` on an option, or `(recommended)` in an option's label (what `ask-owner.sh` already asks for).
- A yes-or-no card names it as `"default": "accept"` or `"default": "reject"` in its payload, with
  `defaultReason` for a no.
- A bot may send `"ownerKind": "must"` (with `mustWhy`) in the payload to keep a card for the owner.

A `default` card that has waited **24 hours** is answered by the engine with its default. The card says
so (`result.appliedByDefault`, `resolvedBy: "default"`), the activity log has
`issue.interaction_applied_by_default`, and the bot is woken as it would be by the owner's answer.

For **seven days** the owner can take that answer back from the digest: the card is open again, is now
`must` (it is never applied by default twice), and the bot is told to stop acting on it and wait. At a
gate, the trip goes back to the gate and asks again. Once the job is finished or the request has landed,
the engine cannot undo it and the digest says so.

A card made before cards had kinds starts its 24 hours when the engine first sees it, not when it was
made, so nothing is applied the moment this is switched on.

## Folding

- The same question asked again on a job while the first still waits is that card, with a count
  (`asked`), not a second card. Its 24 hours are not started again.
- A request has one open gate card at a time; a new round updates it and counts.
- In the digest, every card of one job is one entry, and so is the same question asked from several
  jobs of one request. The entry shows the count.

## The digest

`GET /api/companies/<id>/digest` on the engine; `GET /api/studio/digest` for the PC page and
`GET /v1/digest` for the phone, which add the words a screen prints.

- `cards`: at most five. `must` first (longest waiting first), then `default` (soonest to apply first).
  Each has `kind`, `why` (must) or `default` and `appliesAt`, `count`, and `line`, one sentence.
- `folded`: how many repeats are folded into the cards; `more`: how many cards wait behind the five.
- `applied`: answers applied by default in the last seven days, each with `canReverse`.

Taking one back: `POST /api/issues/<job>/interactions/<card>/reverse` on the engine, or
`POST /api/studio/digest` / `POST /v1/digest` with `{"action": "take-back", "jobId", "cardId"}`. Only
the owner can.

The PC shows the digest at the top of Needs you; the phone at the top of its home screen. A card opens
where it is answered: its job, or the chat it was asked in.
