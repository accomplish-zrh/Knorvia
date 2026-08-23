"""Episode production that lives on a Video Studio project.

Script → review → cast → storyboard shots → voice/subtitles → compose.
Analysis is a local heuristic. Confirm is a human gate. Apply writes into
the existing storyboard strip and character library — it never opens a
second product and never starts a paid job.
"""

from __future__ import annotations

from hashlib import sha256
import re
from typing import Any
from uuid import uuid4

PRODUCTION_DOCUMENT_VERSION = 1
PRODUCTION_STAGES = (
    "script",
    "review",
    "cast",
    "storyboard",
    "shots",
    "voice",
    "compose",
)
REVIEW_STATUSES = ("draft", "confirmed", "rejected")
MAX_SCRIPT_CHARS = 80_000
MAX_ANALYSIS_SHOTS = 80
MAX_ANALYSIS_CHARACTERS = 40
MAX_ANALYSIS_SCENES = 40
MAX_PRODUCTION_BYTES = 1024 * 1024
DEFAULT_SHOT_SECONDS = 5.0

_SCENE_HEADING = re.compile(
    r"^(?:"
    r"(?:INT|EXT|EST|INT/?EXT|I/?E)\b"
    r"|内景|外景|室内|室外"
    r"|第\s*[0-9一二三四五六七八九十百]+\s*场"
    r"|场景\s*[:：]?"
    r")",
    re.IGNORECASE,
)
_NUMBERED_SHOT = re.compile(r"^(?:shot\s*)?(\d{1,3})[.)、:：]\s*(.+)$", re.IGNORECASE)
_CHARACTER_CUE = re.compile(
    r"^(?:【(?P<bracket>[^】]{1,20})】|(?P<name>[A-Z\u4e00-\u9fff][A-Za-z\u4e00-\u9fff·・\-]{0,19}))\s*[:：]\s*(?P<line>.*)$"
)
_ALL_CAPS_CUE = re.compile(r"^[A-Z][A-Z0-9 .\-]{1,24}$")
_CJK = re.compile(r"[\u4e00-\u9fff]")


def empty_production() -> dict[str, Any]:
    return {
        "version": PRODUCTION_DOCUMENT_VERSION,
        "stage": "script",
        "script": {"title": "", "text": "", "language": "en", "source": "paste"},
        "analysis": {
            "title": "",
            "logline": "",
            "scenes": [],
            "characters": [],
            "locations": [],
            "shots": [],
        },
        "review": {
            "status": "draft",
            "notes": "",
            "confirmed_at": None,
            "script_hash": "",
        },
    }


def script_hash(text: str) -> str:
    return sha256(str(text or "").strip().encode("utf-8")).hexdigest()


def detect_script_language(text: str) -> str:
    sample = str(text or "")[:4000]
    if not sample:
        return "en"
    cjk = len(_CJK.findall(sample))
    return "zh" if cjk >= max(8, len(sample) // 8) else "en"


def normalize_production(raw: Any) -> dict[str, Any]:
    base = empty_production()
    if not isinstance(raw, dict):
        return base
    script_raw = raw.get("script") if isinstance(raw.get("script"), dict) else {}
    analysis_raw = raw.get("analysis") if isinstance(raw.get("analysis"), dict) else {}
    review_raw = raw.get("review") if isinstance(raw.get("review"), dict) else {}
    text = str(script_raw.get("text") or "")[:MAX_SCRIPT_CHARS]
    language = str(script_raw.get("language") or "").strip().lower()
    if language not in {"zh", "en"}:
        language = detect_script_language(text)
    stage = str(raw.get("stage") or "script")
    if stage not in PRODUCTION_STAGES:
        stage = "script"
    review_status = str(review_raw.get("status") or "draft")
    if review_status not in REVIEW_STATUSES:
        review_status = "draft"
    stored_hash = str(review_raw.get("script_hash") or "")
    current_hash = script_hash(text)
    if review_status == "confirmed" and stored_hash and stored_hash != current_hash:
        review_status = "draft"
    return {
        "version": PRODUCTION_DOCUMENT_VERSION,
        "stage": stage,
        "script": {
            "title": str(script_raw.get("title") or "")[:160],
            "text": text,
            "language": language,
            "source": str(script_raw.get("source") or "paste")[:40],
        },
        "analysis": {
            "title": str(analysis_raw.get("title") or "")[:160],
            "logline": str(analysis_raw.get("logline") or "")[:400],
            "scenes": _normalize_named_rows(analysis_raw.get("scenes"), MAX_ANALYSIS_SCENES),
            "characters": _normalize_named_rows(
                analysis_raw.get("characters"), MAX_ANALYSIS_CHARACTERS
            ),
            "locations": _normalize_named_rows(analysis_raw.get("locations"), MAX_ANALYSIS_SCENES),
            "shots": _normalize_analysis_shots(analysis_raw.get("shots")),
        },
        "review": {
            "status": review_status,
            "notes": str(review_raw.get("notes") or "")[:4000],
            "confirmed_at": review_raw.get("confirmed_at"),
            "script_hash": stored_hash,
        },
    }


def _normalize_named_rows(raw: Any, limit: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return rows
    for item in raw[:limit]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("title") or "").strip()[:160]
        if not name:
            continue
        row = {
            "id": str(item.get("id") or f"row_{uuid4().hex[:10]}")[:80],
            "name": name,
            "description": str(item.get("description") or item.get("summary") or "")[:2000],
        }
        if item.get("setting"):
            row["setting"] = str(item["setting"])[:200]
        if isinstance(item.get("characters"), list):
            row["characters"] = [
                str(name).strip()[:80] for name in item["characters"] if str(name).strip()
            ][:12]
        rows.append(row)
    return rows


def _normalize_analysis_shots(raw: Any) -> list[dict[str, Any]]:
    shots: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return shots
    for index, item in enumerate(raw[:MAX_ANALYSIS_SHOTS], start=1):
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or "").strip()[:20_000]
        if not prompt:
            continue
        duration = item.get("duration")
        try:
            seconds = float(duration) if duration not in {None, ""} else DEFAULT_SHOT_SECONDS
        except (TypeError, ValueError):
            seconds = DEFAULT_SHOT_SECONDS
        if not (0 < seconds <= 3600):
            seconds = DEFAULT_SHOT_SECONDS
        names = item.get("characters") or item.get("character_names") or []
        if isinstance(names, str):
            names = [part.strip() for part in names.split(",") if part.strip()]
        shots.append(
            {
                "id": str(item.get("id") or f"draft_{index}")[:80],
                "scene_id": str(item.get("scene_id") or "")[:80],
                "title": str(item.get("title") or f"Shot {index}")[:160],
                "prompt": prompt,
                "dialogue": str(item.get("dialogue") or "")[:20_000],
                "duration": seconds,
                "camera": str(item.get("camera") or "")[:64],
                "characters": [str(name).strip()[:80] for name in names if str(name).strip()][:10],
            }
        )
    return shots


def analyze_script(text: str, *, title: str = "", language: str = "") -> dict[str, Any]:
    source = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not source:
        raise ValueError("A script is required")
    if len(source) > MAX_SCRIPT_CHARS:
        raise ValueError("Script exceeds the size limit")
    lang = language if language in {"zh", "en"} else detect_script_language(source)
    blocks = [part.strip() for part in re.split(r"\n\s*\n", source) if part.strip()]
    if not blocks:
        blocks = [line.strip() for line in source.split("\n") if line.strip()]

    scenes: list[dict[str, Any]] = []
    shots: list[dict[str, Any]] = []
    character_order: list[str] = []
    character_lines: dict[str, list[str]] = {}
    current_scene: dict[str, Any] | None = None
    pending_character = ""

    def add_character(name: str, line: str = "") -> None:
        key = name.strip()
        if not key:
            return
        if key not in character_lines:
            character_lines[key] = []
            character_order.append(key)
        if line:
            character_lines[key].append(line.strip())

    def add_shot(*, prompt: str, title: str = "", dialogue: str = "") -> None:
        if len(shots) >= MAX_ANALYSIS_SHOTS:
            return
        visual = prompt.strip()
        if not visual:
            return
        scene = current_scene or {}
        names = list(scene.get("characters") or [])
        if pending_character and pending_character not in names:
            names.append(pending_character)
        shots.append(
            {
                "id": f"draft_{len(shots) + 1}",
                "scene_id": str(scene.get("id") or ""),
                "title": (title or visual[:24] or f"Shot {len(shots) + 1}")[:160],
                "prompt": _shot_prompt(visual, scene, lang),
                "dialogue": dialogue[:20_000],
                "duration": DEFAULT_SHOT_SECONDS,
                "camera": "",
                "characters": names[:10],
            }
        )

    for block in blocks:
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        heading = lines[0]
        numbered = _NUMBERED_SHOT.match(heading)
        cue = _CHARACTER_CUE.match(heading)
        if _SCENE_HEADING.match(heading) and len(scenes) < MAX_ANALYSIS_SCENES:
            current_scene = {
                "id": f"scene_{len(scenes) + 1}",
                "name": heading[:160],
                "description": " ".join(lines[1:])[:2000],
                "setting": heading[:200],
                "characters": [],
            }
            scenes.append(current_scene)
            pending_character = ""
            continue
        if numbered:
            add_shot(prompt=numbered.group(2), title=f"Shot {numbered.group(1)}")
            pending_character = ""
            continue
        if cue:
            name = (cue.group("bracket") or cue.group("name") or "").strip()
            spoken = (cue.group("line") or "").strip()
            rest = " ".join(lines[1:]).strip()
            add_character(name, spoken or rest)
            pending_character = name
            if current_scene is not None and name not in current_scene["characters"]:
                current_scene["characters"].append(name)
            add_shot(
                prompt=rest or spoken or heading,
                title=name,
                dialogue=" ".join(part for part in (spoken, rest) if part),
            )
            continue
        if _ALL_CAPS_CUE.match(heading) and len(heading.split()) <= 4:
            pending_character = heading.title()
            add_character(pending_character)
            spoken = " ".join(lines[1:]).strip()
            if spoken:
                add_character(pending_character, spoken)
                add_shot(prompt=spoken, title=pending_character, dialogue=spoken)
            continue
        add_shot(prompt=" ".join(lines), title=heading[:24])

    if not shots:
        add_shot(prompt=source[:2000], title=title or ("第一镜" if lang == "zh" else "Shot 1"))

    characters = [
        {
            "id": f"cast_{index}",
            "name": name,
            "description": " / ".join(character_lines[name][:3])[:2000],
        }
        for index, name in enumerate(character_order[:MAX_ANALYSIS_CHARACTERS], start=1)
    ]
    locations = [
        {
            "id": scene["id"],
            "name": scene["name"],
            "description": scene.get("description") or "",
        }
        for scene in scenes
    ]
    first_prompt = shots[0]["prompt"] if shots else ""
    return {
        "title": (title or (scenes[0]["name"] if scenes else ""))[:160],
        "logline": first_prompt[:400],
        "scenes": scenes,
        "characters": characters,
        "locations": locations,
        "shots": shots,
    }


def _shot_prompt(visual: str, scene: dict[str, Any], language: str) -> str:
    setting = str(scene.get("setting") or scene.get("name") or "").strip()
    if setting and setting not in visual:
        joiner = "，" if language == "zh" else ", "
        return f"{setting}{joiner}{visual}"[:20_000]
    return visual[:20_000]


def confirm_review(document: dict[str, Any], *, notes: str = "", now: float) -> dict[str, Any]:
    production = normalize_production(document)
    if not production["script"]["text"].strip():
        raise ValueError("Confirming a review requires a script")
    if not production["analysis"]["shots"]:
        raise ValueError("Analyze the script before confirming it")
    production["review"] = {
        "status": "confirmed",
        "notes": str(notes or production["review"]["notes"])[:4000],
        "confirmed_at": now,
        "script_hash": script_hash(production["script"]["text"]),
    }
    production["stage"] = "cast"
    return production


def reopen_review(document: dict[str, Any], *, notes: str = "") -> dict[str, Any]:
    production = normalize_production(document)
    production["review"] = {
        "status": "draft",
        "notes": str(notes or production["review"]["notes"])[:4000],
        "confirmed_at": None,
        "script_hash": production["review"].get("script_hash") or "",
    }
    production["stage"] = "review"
    return production


def review_is_current(document: dict[str, Any]) -> bool:
    production = normalize_production(document)
    review = production["review"]
    return (
        review["status"] == "confirmed"
        and bool(review.get("script_hash"))
        and review["script_hash"] == script_hash(production["script"]["text"])
    )


def production_readiness(
    document: dict[str, Any],
    *,
    characters: list[dict[str, Any]] | None = None,
    shots: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    production = normalize_production(document)
    cast = list(characters or [])
    strip = list(shots or [])
    needed = [item["name"] for item in production["analysis"]["characters"]]
    bound_names = {str(item.get("name") or "").strip() for item in cast}
    keyframes = sum(1 for shot in strip if shot.get("keyframe_asset_id"))
    videos = sum(1 for shot in strip if shot.get("output_asset_id"))
    voices = sum(
        1 for shot in strip if shot.get("voiceover_asset_id") or shot.get("voiceover_text")
    )
    return {
        "script": bool(production["script"]["text"].strip()),
        "analysis": bool(production["analysis"]["shots"]),
        "review": review_is_current(production),
        "cast": {
            "needed": needed,
            "bound": [name for name in needed if name in bound_names],
            "ready": bool(needed) and all(name in bound_names for name in needed),
        },
        "storyboard": {"shots": len(strip), "ready": bool(strip)},
        "keyframes": {"ready": keyframes, "total": len(strip)},
        "videos": {"ready": videos, "total": len(strip)},
        "voice": {"ready": voices, "total": len(strip)},
        "compose": videos > 0 and videos == len(strip) and bool(strip),
    }


def upsert_analysis_characters(
    store: Any,
    project_id: str,
    analysis: dict[str, Any],
) -> dict[str, str]:
    """Create missing character-library rows from analyzed names. Free."""
    existing = {
        str(item.get("name") or "").strip(): item for item in store.list_characters(project_id)
    }
    mapping: dict[str, str] = {}
    for item in analysis.get("characters") or []:
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        current = existing.get(name)
        if current is None:
            current = store.create_character(
                project_id,
                name=name,
                description=str(item.get("description") or ""),
            )
            existing[name] = current
        mapping[name] = str(current["id"])
    return mapping


def apply_production(
    store: Any,
    project_id: str,
    *,
    replace: bool = False,
    place_on_board: bool = True,
) -> dict[str, Any]:
    """Write the confirmed analysis onto storyboard + cast. No paid jobs."""
    payload = store.get_production(project_id)
    production = payload["production"]
    if not review_is_current(production):
        raise ValueError("Confirm the script review before applying it to the storyboard")
    mapping = upsert_analysis_characters(store, project_id, production["analysis"])
    board = store.get_storyboard(project_id)
    shots = apply_analysis_to_storyboard(
        production["analysis"],
        list(board.get("shots") or []),
        mapping,
        replace=replace or not (board.get("shots") or []),
    )

    def write_shots(document: dict[str, Any]) -> None:
        document["shots"] = shots

    storyboard = store.update_storyboard(project_id, write_shots)
    placed = {"imported": 0, "skipped": 0}
    if place_on_board:
        from knorvia.services.video_studio.board import import_storyboard_shots

        def place(document: dict[str, Any]) -> None:
            placed["imported"], placed["skipped"] = import_storyboard_shots(document, shots)

        store.update_board(project_id, place)
    production["stage"] = "storyboard"
    saved = store.save_production(project_id, production)
    return {
        **saved,
        "storyboard": storyboard,
        "character_ids": mapping,
        "board": placed,
    }


def apply_analysis_to_storyboard(
    analysis: dict[str, Any],
    current_shots: list[dict[str, Any]],
    name_to_character_id: dict[str, str],
    *,
    replace: bool = False,
) -> list[dict[str, Any]]:
    planned = _normalize_analysis_shots((analysis or {}).get("shots"))
    if not planned:
        raise ValueError("There are no analyzed shots to apply")
    if current_shots and not replace:
        raise ValueError("Storyboard already has shots; pass replace=true to rebuild unused ones")
    kept = [
        dict(shot)
        for shot in current_shots
        if replace and (shot.get("output_asset_id") or shot.get("job_id"))
    ]
    used_titles = {str(shot.get("title") or "") for shot in kept}
    next_shots = list(kept)
    for index, item in enumerate(planned, start=1):
        if item["title"] in used_titles:
            continue
        next_shots.append(
            {
                "id": f"shot_{uuid4().hex}",
                "order": len(next_shots),
                "title": item["title"] or f"Shot {index}",
                "prompt": item["prompt"],
                "keyframe_prompt": item["prompt"],
                "voiceover_text": item["dialogue"],
                "character_ids": [
                    name_to_character_id[name]
                    for name in item["characters"]
                    if name in name_to_character_id
                ],
                "input_asset_ids": [],
                "job_id": None,
                "output_asset_id": None,
                "duration": item["duration"],
                "camera": item["camera"],
                "notes": item.get("scene_id") or "",
                "transition": "crossfade" if next_shots else "",
            }
        )
    return next_shots
