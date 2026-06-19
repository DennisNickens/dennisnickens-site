#!/usr/bin/env python3
"""
Parse YOU-CALL-YOURSELF-A-FRIEND-V2-GAME-MECHANIC.md into cards.json.

Reads each ### Card N (TYPE) block, extracts the question text, options
(for MC types), and emits a structured JSON file the PWA can load.

Run once whenever the content draft changes:
  python3 scripts/parse-friend-cards.py

Output: games/friend/cards.json
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "..", "Strategy", "YOU-CALL-YOURSELF-A-FRIEND-V2-GAME-MECHANIC.md"))
OUT = os.path.normpath(os.path.join(HERE, "..", "games", "friend", "cards.json"))

# Map markdown type label -> internal type code
TYPE_MAP = {
    "MC4": "mc4",
    "MC6": "mc6",
    "T/F": "tf",
    "Group Vote": "group_vote",
    "Reflection - no scoring": "reflection",
    "Discussion - no scoring": "discussion",
}

# Default scoring per card type. Variations in cards (e.g. group vote with
# different point amounts) can be overridden via the points field per card.
DEFAULT_SCORING = {
    "mc4": {"guesserPoints": 2, "subjectPoints": 1},
    "mc6": {"guesserPoints": 3, "subjectPoints": 1},
    "tf":  {"guesserPoints": 1, "subjectPoints": 1},
    "group_vote": {"guesserPoints": 2, "subjectPoints": 3},
    "reflection": {"guesserPoints": 0, "subjectPoints": 0},
    "discussion": {"guesserPoints": 0, "subjectPoints": 0},
}

# Themes section the card lives under (Presence, Truth, Investment, etc.)
THEME_RE = re.compile(r"^## THEME \d+: (\w+)", re.MULTILINE)
CARD_HEADER_RE = re.compile(r"^### Card (\d+) \(([^)]+)\)\s*$", re.MULTILINE)
OPTION_RE = re.compile(r"^([A-F])\)\s+(.+)$")


def parse_cards(md_text):
    # Walk through the document, tracking the current theme. For each
    # "### Card N (TYPE)" header, capture everything until the next card
    # header or theme header, and parse out the question + options.

    # Build a list of (line_no, kind, payload) markers.
    lines = md_text.split("\n")
    current_theme = None
    cards = []
    i = 0
    while i < len(lines):
        line = lines[i]
        theme_match = re.match(r"^## THEME \d+: (.+)$", line)
        if theme_match:
            current_theme = theme_match.group(1).strip().title()
            i += 1
            continue
        card_match = re.match(r"^### Card (\d+) \(([^)]+)\)\s*$", line)
        if not card_match:
            i += 1
            continue
        card_num = int(card_match.group(1))
        type_label = card_match.group(2).strip()
        internal_type = TYPE_MAP.get(type_label)
        if not internal_type:
            print(f"WARNING: unknown type label '{type_label}' for card {card_num}", file=sys.stderr)
            i += 1
            continue

        # Collect the body lines until we hit the next ### Card or ## or end.
        body_lines = []
        i += 1
        while i < len(lines):
            nxt = lines[i]
            if re.match(r"^### Card \d+ \(", nxt):
                break
            if re.match(r"^## ", nxt):
                break
            body_lines.append(nxt)
            i += 1

        # The first non-empty bold line is the question text.
        # Options are A) ... B) ... etc.
        # Italic lines (start with *) are the play instructions; we keep them for reference.
        question = ""
        options = []
        play_notes = []
        for bl in body_lines:
            stripped = bl.strip()
            if not stripped:
                continue
            # Question is usually bold: **...**
            if stripped.startswith("**") and not question:
                question = stripped.strip("*").strip()
                continue
            opt_match = OPTION_RE.match(stripped)
            if opt_match:
                options.append({
                    "letter": opt_match.group(1),
                    "text": opt_match.group(2).strip()
                })
                continue
            # Italic instructions for the play mechanic (we keep them for context only)
            if stripped.startswith("*") and stripped.endswith("*"):
                play_notes.append(stripped.strip("*").strip())
                continue

        card = {
            "id": card_num,
            "theme": current_theme or "Uncategorized",
            "type": internal_type,
            "text": question,
            "options": options if options else None,
            "scoring": dict(DEFAULT_SCORING[internal_type]),
            "playNotes": " ".join(play_notes) if play_notes else None
        }
        # Strip None values for cleaner JSON
        card = {k: v for k, v in card.items() if v is not None}
        cards.append(card)

    return cards


def main():
    if not os.path.exists(SRC):
        print(f"ERROR: source file not found: {SRC}", file=sys.stderr)
        sys.exit(1)

    with open(SRC, "r") as f:
        md = f.read()

    cards = parse_cards(md)

    if len(cards) != 72:
        print(f"WARNING: parsed {len(cards)} cards, expected 72", file=sys.stderr)

    # Validate every MC card has options
    for c in cards:
        if c["type"] in ("mc4", "mc6") and not c.get("options"):
            print(f"ERROR: card {c['id']} ({c['type']}) is missing options", file=sys.stderr)
            sys.exit(1)
        if c["type"] == "mc4" and c.get("options") and len(c["options"]) != 4:
            print(f"WARNING: MC4 card {c['id']} has {len(c['options'])} options (expected 4)", file=sys.stderr)
        if c["type"] == "mc6" and c.get("options") and len(c["options"]) != 6:
            print(f"WARNING: MC6 card {c['id']} has {len(c['options'])} options (expected 6)", file=sys.stderr)
        if not c.get("text"):
            print(f"WARNING: card {c['id']} has empty text", file=sys.stderr)

    # Em-dash safety check (Dennis's non-negotiable rule)
    for c in cards:
        joined = c.get("text", "") + " ".join(o["text"] for o in (c.get("options") or []))
        for bad in ("—", "–"):
            if bad in joined:
                print(f"ERROR: card {c['id']} contains forbidden dash '{bad}'", file=sys.stderr)
                sys.exit(1)

    type_counts = {}
    for c in cards:
        type_counts[c["type"]] = type_counts.get(c["type"], 0) + 1

    out_doc = {
        "deck_name": "You Call Yourself A Friend",
        "subtitle": "How well do you really know your people?",
        "author": "Dennis Nickens, AKA Spiritual Romeo",
        "scoring_cap": 25,
        "min_players": 4,
        "max_players": 10,
        "type_counts": type_counts,
        "cards": cards
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out_doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Wrote {len(cards)} cards to {OUT}")
    print(f"Type counts: {type_counts}")


if __name__ == "__main__":
    main()
