---
type: decision
date: 2026-09-02
status: accepted
tags: [shop, repos]
supersedes: 
superseded_by: 
---
# One repo per shop

## Decision
Each client shop lives in its own repository, with its own tests and deploys.

## Why
A shared repo made one shop's failing test block every other shop's release.

## Related
- [[tests-before-merge]]
