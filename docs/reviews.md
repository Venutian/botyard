# Reviews: marking exact places in a bot's work

A **review** is the owner's answer to a piece of a bot's work, given by pointing rather than describing.
Each **mark** pins a comment to a place; all the marks of a review go to the bot as **one message**.

## What can be marked

| Piece | How a mark is made | What the bot is told |
|---|---|---|
| A bot's message, the job's brief, a document (plan, report) | select words or whole lines | the quote, and where: document and line, or message, paragraph and line |
| A picture on the job (a screenshot, a store image) | tap a point or drag a box | the picture's name, the box in pixels, and a cut copy of that place beside the words |
| The job's change, read in chapters | select lines in the diff | the file, the lines (as in the file after the change) and the chapter |
| A page running on this computer | point at an element | the page's address, the element, its words, and a screenshot cut to it |

Marks from several pieces can go in one review. Where a quote is, is read from the piece itself, not
taken on trust; words that are not there are refused.

## Where it is

- **PC**: the Review button on a job's sheet and in a chat opens the review sheet, the bot's last message
  first. Unsent marks are kept in the browser until they are sent.
- **Phone**: "Review: mark what to change" on a job, the pin in a chat's header. Hold on a word and drag
  the handles to select; tap or drag on a picture. The change in chapters and live pages are on the PC.
- **A trip waiting at a gate** ([tracks](tracks.md)): the gate's "Mark exact places" opens the sheet on the
  work; the marks are the note the work goes back with. There is no second gate.

## Sending

Only the owner sends a review: a bot's pass is refused by the engine (`POST /issues/:id/reviews`), and
the page's and phone's own paths refuse a call made from a bot's run. A review becomes one comment on the
job, which wakes its bot like any word from the owner, with the cut copies attached beside it. "Approve
and keep" records the piece as approved without asking the bot for anything.

## The answer tray

Questions wait in Needs you while the crew carries on. "Answer here" on a question holds the answer in
the tray at the top of Needs you; a review can be held there too. One press sends everything held, each
to the job that asked; one that fails stays in the tray with the reason. The Needs you count does not
change until an answer is sent. The tray is kept by the service, so the PC and the phone hold the same.

## Reading a big change

A script sorts a job's change into chapters: **the heart of it** (the source that changed most, new files
first), **what it touches** (other source naming it), **how it is checked** (tests) and **the glue**
(settings, notes, small edits), each with a two-line overview. "Overviews in plain words" asks a small
model once per change and keeps the answer. The command is `BOTYARD_OVERVIEW_COMMAND`, or one line in the
settings folder's `overview-command` file; the prompt goes in on stdin, JSON comes out.

## Live pages

Only `localhost`, the loopback addresses and `*.localhost` names. The page opens through a relay that
listens on the loopback address only and adds one script, the pointer; nothing else is changed. The
screenshot is taken by a headless Chromium-family browser (`BOTYARD_BROWSER` names one) at the owner's
size and scroll.

## The record

Every review is kept, read-only: "Reviews kept" on a job, and on a project's page, lists each piece
approved or sent back with the words the bot was sent and the cut copies.
