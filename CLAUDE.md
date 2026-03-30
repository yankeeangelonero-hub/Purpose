# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What This Is

This repo contains two related but distinct systems for SillyTavern:

1. **Gravity** — A narrative engine preset + companion SillyTavern extension. The LLM outputs structured `---LEDGER---` blocks after each response; the extension parses them to maintain a live state machine (characters, constraints, collisions, chapters).

2. **Purpose** (legacy, in `Reference/`) — An earlier preset architecture based on toggle blocks, `{{setvar}}`/`{{getvar}}` macros, and layered prompts (L0–L3). Kept for reference only.

## Repository Layout

```
Gravity_v11.json              — Current Gravity preset (API params + prompt ordering)
Gravity_v10_r.json            — Previous Gravity version (reference)
Gravity_v10_Preset_Tools.json — Companion lorebook for Gravity v10
gravity-ledger/               — SillyTavern extension (JS) — the state engine
  index.js                    — Entry point, wires everything together
  state-machine.js            — Ledger transaction processor, entity CRUD
  state-compute.js            — Derived state calculations
  state-view.js               — Lorebook entry rendering (dossiers, collisions, etc.)
  ledger-store.js             — Persistence (SillyTavern chat metadata)
  regex-intercept.js          — Intercepts LLM output to extract LEDGER blocks
  consistency.js              — Drift detection + auto-nudge injection
  snapshot-mgr.js             — Snapshot/rollback management
  ooc-handler.js              — OOC command dispatch (eval, snapshot, rollback, history)
  lorebook-api.js             — SillyTavern lorebook read/write API wrapper
  ui-panel.js                 — Settings/debug panel UI
  gravity-system-prompt.md    — Canonical system prompt (paste into character card)
  Persona_Engine_Lorebook.json — Persona support lorebook
  Persona_TifaLockhart_v4.json — Example persona card
Examples/                     — Example lore books
Reference/                    — Old Purpose v8/v9 files; do not edit
```

## Gravity Architecture

### Preset (Gravity_v11.json)
Standard SillyTavern JSON preset. Key fields:
- `prompts[]` — Prompt segments with `identifier`, `content`, `enabled`, `injection_position`, `injection_depth`
- `prompt_order[]` — Injection sequence per `character_id` (100000 = default, 100001 = preset-specific)
- `assistant_prefill` — Forces the model to begin output in a specific format

### Extension (gravity-ledger/)
A SillyTavern extension loaded from `manifest.json`. It does NOT run outside SillyTavern.

**Data flow:**
1. Model generates narrative + `---LEDGER--- [...] ---END LEDGER---` block
2. `regex-intercept.js` strips the ledger block from visible output
3. `state-machine.js` applies transactions to in-memory state
4. `state-view.js` renders updated state into lorebook entries (injected into next context)
5. `ledger-store.js` persists state in SillyTavern chat metadata
6. `consistency.js` detects format drift and injects correction nudges

**Ledger transaction ops:** `CR` (create), `TR` (transition), `S` (set field), `A` (append array), `R` (remove array), `MS` (map set), `MR` (map remove), `D` (destroy)

**Entity types:** `char`, `constraint`, `collision`, `chapter`, `world`, `pc`
- `world` and `pc` are singletons — no `id` field
- Entity IDs are kebab-case and immutable once assigned
- State machine transitions (`TR`) cannot skip levels (e.g., KNOWN → TRACKED → PRINCIPAL, never KNOWN → PRINCIPAL)

### System Prompt (gravity-system-prompt.md)
The canonical instructions pasted into a character card. Defines:
- Core principles (show don't tell, constraint-driven drama, collision architecture)
- Character tier system: UNKNOWN → KNOWN → TRACKED → PRINCIPAL
- Constraint structure and integrity levels: STABLE → STRESSED → CRITICAL → BREACHED
- Collision structure and distance countdown (10 → 0)
- Chapter lifecycle: PLANNED → OPEN → CLOSING → CLOSED
- Ledger format spec and OOC commands

## Key Editing Rules

### JSON Preset
- `prompt_order` UUIDs must match `identifier` fields in `prompts[]` — mismatches silently drop prompts
- `injection_position: 0` = in-chat, `injection_position: 1` = after system prompt
- `injection_depth` counts messages from the end of chat history

### Extension JS
- The extension runs in SillyTavern's browser context — standard web JS, no Node built-ins
- `lorebook-api.js` wraps SillyTavern's internal lorebook API; check it before touching lorebooks directly
- State is stored in `chat_metadata` via SillyTavern's `saveMetadata()` — not localStorage
- `consistency.js` injects nudges by appending to the system prompt on the next turn; don't break the injection hook in `index.js`

### Ledger Format
The `---LEDGER---` / `---END LEDGER---` delimiters are parsed by regex — do not change them. The JSON array inside must be valid; malformed blocks are logged and skipped, not crashed on.
