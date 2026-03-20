# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Purpose is a **SillyTavern preset system** (v8) for interactive fiction and roleplay. It consists of two JSON files that define an LLM prompting framework — not a software project with build steps or tests.

- **Purpose_v8.json** — The main preset. Contains API parameters, prompt ordering, and a layered prompt architecture assembled from toggle blocks and injected prompt segments.
- **Purpose_Preset_Tools.json** — Companion lorebook/world info entries. Contains keyword-triggered tool prompts (OOC commands) that activate when specific phrases appear in chat.

## Architecture

### Purpose_v8.json — Layered Prompt System

The preset builds a prompt from composable sections. The `prompts` array contains both **marker slots** (SillyTavern injection points like `charDescription`, `chatHistory`) and **custom prompt segments** organized into:

**Section A — Toggle Blocks (Groups 1–8):** Mutually exclusive options configured by enabling exactly one per group. Each uses `{{setvar::key::value}}` to set a variable consumed downstream.
- Group 1: Role (Roleplayer / Game Master / Writer)
- Group 2: Tense (Past / Present)
- Group 3: Narration (Third-Person / First-Person / Second-Person)
- Group 4: Perspective (Omniscient / Character's POV / User's POV)
- Group 5: Length (Flexible / Page / Short / Moderate)
- Group 6: Guidelines (NSFW / SFW)
- Group 7: Voice Declaration (player-configured via OOC)
- Group 8: Tone Declaration (player-configured via OOC)

**Core Layers (L0–L3):** The main system instructions, always-on or toggled per use case.
- **L0 — The Dossiers:** Character registry (5 NPC slots with 5-layer dossiers: State, Synopsis, Relationships, Key Moments, Noticed Details), PC dossier, and World dossier (factions, world state, pressure points, story arcs). All stored via `{{getvar::}}` / `{{setvar::}}` macros.
- **L1 — The Machine:** State management protocol. Defines TURN_STATE (inline per-turn state block) and REGISTRY (variable persistence via SillyTavern macros). Specifies variable syntax (`setvar`, `addvar`, `incvar`) and what lives inline vs. in variables.
- **L2 — The Engine:** Core game logic. Defines author principles (Logic, Fairness, Consistency, Honesty), entropy system (2d10 table), thread mechanics (story forces with distances that converge over time), deduction block format, knowledge firewall, death rules, pacing, and narrative architecture (history vs. draft).
- **L3 — The Craft:** Prose rules. Voice matching, dialogue guidelines, concrete detail requirements, structural bans (specific phrases and patterns to avoid), dynamic description system, NPC generation rules.

**Additional Layers:**
- **TunnelVision — World Bible:** Lorebook management protocol for persistent world-building (locations, NPCs, factions, events).
- **Sonnet Reliability Anchor:** Anti-drift rules and turn sequence specification (Deduction → Prose → Scene tag → Dossier Changes → TURN_STATE → REGISTRY).

### Purpose_Preset_Tools.json — OOC Command Lorebook

Keyword-triggered entries that activate when the player types specific OOC phrases:
- `OOC: set voice` / `OOC: configure` — Voice & tone setup wizard (16 questions)
- `OOC: archive` — History archive protocol to keep variables lean
- `OOC: preflight` / `OOC: status` — Health check for story foundations
- `OOC: close chapter` / `OOC: next chapter` — Full chapter transition protocol (close + health check + open)
- `OOC: enable danbooru` — Scene illustration via Danbooru tags (NovaFlat XL)
- `OOC: enable zimage` — Scene illustration via natural language (Z-Image)

Scene illustration entries are in a `scene_illustration` group (mutually exclusive).

## Key Concepts for Editing

- **Variable flow:** Toggle blocks set variables via `{{setvar::}}` → Core layers consume them via `{{getvar::}}`. Renaming a variable key in one place requires updating all references.
- **Prompt ordering:** The `prompt_order` arrays (character_id `100000` for default, `100001` for preset-specific) control injection sequence. Identifier UUIDs must match between `prompts` entries and `prompt_order` entries.
- **Injection position:** `injection_position: 0` = in-chat, `injection_position: 1` = after system prompt. `injection_depth` controls how many messages from the end to inject.
- **Entry activation in the lorebook:** `key` arrays define trigger phrases. `sticky` keeps the entry active for N additional turns. `scanDepth` controls how far back in chat to scan for keywords. `constant: true` means always active.
- **The `{{trim}}` macro** strips whitespace from disabled/empty toggle blocks to keep the prompt clean.

## Editing Guidelines

- When modifying prompt content, preserve the `{{setvar::}}` / `{{getvar::}}` macro syntax exactly — mismatched braces or colons silently break variable storage.
- Toggle group entries must remain mutually exclusive — only one enabled per group at a time.
- The L0–L3 layer structure is load-bearing; L2 (Engine) references variables set by L0 (Dossiers) and toggle blocks, and L3 (Craft) references variables from both.
- TURN_STATE and REGISTRY block formats in L1 are regex-parsed by the consuming model — structural changes to delimiters (`<!-- TURN_STATE -->`, `<!-- REGISTRY -->`) will break state tracking.
- Lorebook entries in the tools file use `uid` as their key in the `entries` object — new entries should use the next sequential uid.
