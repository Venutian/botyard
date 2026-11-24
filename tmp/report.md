# NGE-2517 Engram: zoom titles stay visible on screen - Fix Report

## Summary
Fixed three issues in the Engram zoom overlay:
1. **Hidden label slots visibility**: Added CSS rule `.bf-node-label[hidden] { display: none !important; }` to ensure pooled labels are properly hidden when not in use.
2. **Viewport bounds checking**: Modified `_placeNodes()` and `_placeExcerpt()` in brain-field.js to clamp label and excerpt positions within the viewport, preventing them from rendering offscreen at immersive zoom distances.
3. **Deck closure for screenshots**: Updated shots.mjs to close the deck (via `[data-act="close-col"]` with fallback) before capturing Engram screenshots.

## Changes Made

### 1. CSS Fix (studio/src/ui/brain-map.css:93)
```css
.brainmap .bf-node-label[hidden] { display: none !important; }
```
Ensures the `hidden` attribute on pooled label elements takes precedence over the `display: inline-flex` rule.

### 2. Viewport Clamping in brain-field.js
- **`_placeExcerpt()` (lines 559-574)**: Added bounds checking to clamp excerpt plate position within stage boundaries.
- **`_placeNodes()` (lines 577-628)**: Added viewport bounds filtering (skip labels >50px outside viewport) and position clamping for shown labels.

### 3. Screenshot Deck Closure (studio/tools/shots.mjs)
Updated Engram shot definitions to click `[data-act="close-col"]` (with `body` fallback) before navigating to Engram view.

### 4. Test Coverage (studio/test/brain.test.mjs)
Added three new tests:
- `label placement: viewport bounds checking keeps labels on screen`
- `label placement: zoom factor at immersive distances`
- `excerpt clamping: excerpt plate stays within viewport bounds`

## Test Results
- Brain tests: **14/14 pass** (including 3 new tests for visibility/clamping)
- Full suite: **521 pass, 85 fail, 1 warn** (baseline failures unrelated to this fix: company settings, phone, shape, work, yard layout)

## Screenshots Captured
- `engram.png` (1440×900, day) - 151 KB
- `engram-night.png` (1440×900, night) - 241 KB  
- `engram-phone.png` (375×812, day) - 87 KB
- `engram-phone-night.png` (375×812, night) - 87 KB

All four screenshots show Engram with deck closed, no onboarding overlay.

## Verification Checklist
- [x] `node --test test/brain.test.mjs` passes (14/14)
- [x] `npm test` reports exact baseline (521 pass, 85 fail)
- [x] Hidden labels compute to `display: none` (CSS fix verified)
- [x] Labels clamped to viewport at distances 210 and 150 (code review)
- [x] Excerpt rectangle stays inside `.bm-stage` (code review)
- [x] At least 6 titles visible at immersive distances (code review - LABEL_MAX=12, nearest-first)
- [x] Deck closed before screenshots (shots.mjs updated)
- [x] Screenshots captured at 1440×900 and 375×812, day and night
- [x] Click-to-open, reduced-motion, bokeh day/night, day contrast preserved (no changes to these features)

## Remaining Issues
- `engram-note` screenshot fails due to async brain data loading timing (separate issue, not required by brief)
- 85 baseline test failures unrelated to Engram zoom (pre-existing)

## Commit
All changes committed to branch NGE-2517-fix.