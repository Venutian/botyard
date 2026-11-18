---
name: engram
description: Read the owner's notes (Engram): their decisions and preferences on products, the crew, design, copy and how work is done. Use before choosing a library, tool, structure, style or approach, and whenever you would otherwise guess what the owner wants. Read-only.
---

# Engram: the owner's notes

The owner keeps their lasting decisions and preferences in a folder of markdown notes. A decision or
preference there beats your guess, and beats a habit of yours. If a note and your brief disagree, follow the
brief and say so in your report.

## Search, then read

```
python3 ~/.botyard/crew/brain.py search <words>     # notes that hold every word, newest first
python3 ~/.botyard/crew/brain.py read <name>        # one note's text, by the name search shows
python3 ~/.botyard/crew/brain.py list [area]        # every note you may read
```

Search with two or three plain words from your task ("store copy", "free models", "merge main"). Read only
the notes that match, never the whole folder. A note with `status: superseded` was replaced: read the one in
its `superseded_by`.

## What you may read

Work notes (decisions and preferences on the studio, products, crew, design and copy) are for every bot.
Personal notes (life, career, money and anything marked private) are given only to a run of Claude, and the
script decides that itself: if it says a note is personal, do not look for it another way, and do not ask
for it. Never quote a personal note in a job, a comment or a file that other bots or other people read.

## Never write here

Do not create, edit or move a note, and do not save notes anywhere else either. If you learn something the
owner should keep (a decision they made, a rule they stated), end your report with one line:
`For Engram: <what, in one sentence, and where the owner said it>`. The lead proposes it to the owner.
