from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time

from knorvia.services.creative_library.store import MAX_ENTRY_TEXT, CreativeLibraryStore
from knorvia.services.creative_library.welcome.pack import (
    FOLDER_ID,
    FOLDER_TITLE,
    SEED_KEY,
    built_documents,
    html_preview_scripts,
    welcome_html_digests,
)
from knorvia.services.creative_library.welcome.shell import LIBRARY_HTML_CSP
from knorvia.services.creative_library.welcome.v1_legacy import (
    V1_FOLDER_TITLE,
    V1_HTML_DIGESTS,
    V1_SEED_KEY,
)
from knorvia.services.creative_library.welcome.v2_legacy import (
    V2_HTML_DIGESTS,
    V2_SEED_KEY,
)


def _meta(store: CreativeLibraryStore, key: str = SEED_KEY) -> dict | None:
    db = sqlite3.connect(store.db_path)
    try:
        row = db.execute("SELECT value FROM library_meta WHERE key=?", (key,)).fetchone()
    finally:
        db.close()
    if row is None:
        return None
    return json.loads(row[0])


def _welcome_folder(tree: dict) -> dict:
    matches = [item for item in tree["items"] if item["id"] == FOLDER_ID]
    assert len(matches) == 1
    return matches[0]


def test_welcome_documents_cover_beginner_topics() -> None:
    docs = built_documents()
    assert len(docs) == 10
    titles = [doc.title for doc in docs]
    assert titles[0].startswith("00 全景")
    blob = "\n".join(doc.html for doc in docs)
    for needle in (
        "Knorvia",
        "结构",
        "第一次",
        "工具",
        "能力",
        "资料库",
        "知识库",
        "Base URL",
        "API Key",
        "模型名",
        "不要把真实 API Key",
        "设置 → LLM",
        "运行测试",
        "OpenAI",
        "DeepSeek",
        "Ollama",
        "活计",
        "钥匙",
    ):
        assert needle in blob
    assert "geogebra" not in blob.lower()
    assert 'id="sim-check"' in blob
    assert "data-wizard" in blob
    assert 'id="quiz-grade"' in blob
    assert 'id="decode-run"' in blob
    assert 'role="status"' in blob
    assert 'aria-live="polite"' in blob
    assert blob.count("<svg") >= 8
    assert 'data-welcome-pack="v3"' in blob


def test_welcome_html_is_offline_interactive_and_accessible() -> None:
    forbidden = (
        "cdn.jsdelivr",
        "unpkg.com",
        "fonts.googleapis",
        "google-analytics",
        "fetch(",
        "XMLHttpRequest",
        "WebSocket",
        "sendBeacon",
        "allow-same-origin",
        "@font-face",
    )
    key_like = re.compile(r"sk-[A-Za-z0-9]{16,}")
    for doc in built_documents():
        html = doc.html
        assert len(html) < MAX_ENTRY_TEXT
        assert 'lang="zh-CN"' in html
        assert LIBRARY_HTML_CSP in html
        assert "connect-src 'none'" in html
        assert "prefers-reduced-motion" in html
        assert "prefers-contrast" in html
        assert "max-width:620px" in html
        assert 'href="#main"' in html
        assert "<details" in html or 'type="checkbox"' in html or 'type="radio"' in html
        assert 'aria-label="工作台目录"' in html
        assert 'http-equiv="Content-Security-Policy"' in html
        assert not re.search(r"""href\s*=\s*['"]https?:""", html, re.I)
        for token in forbidden:
            assert token not in html
        assert not key_like.search(html)
        assert "钥匙" in html
        assert "overflow-wrap:anywhere" in html
        assert "label:has(:focus-visible)" in html


def test_provider_page_wraps_long_code_and_stamp_labels() -> None:
    providers = next(doc for doc in built_documents() if doc.entry_id.endswith("_providers"))
    html = providers.html
    assert "generativelanguage.googleapis.com" in html
    assert "compatible-mode/v1" in html
    assert "overflow-wrap:anywhere" in html
    assert "word-break:break-word" in html
    assert re.search(r"\.stamps\.tabs\{[^}]*display:grid", html)
    assert "overflow-x: hidden" not in html
    assert ".switcher .tabs label:has(:focus-visible)" in html


def _chrome_executable() -> Path | None:
    for candidate in (
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path.home() / r"AppData\Local\Google\Chrome\Application\chrome.exe",
        Path("/usr/bin/google-chrome"),
        Path("/usr/bin/chromium"),
    ):
        if candidate.is_file():
            return candidate
    which = shutil.which("chrome") or shutil.which("google-chrome") or shutil.which("chromium")
    return Path(which) if which else None


def test_provider_page_scroll_width_matches_client_width(tmp_path: Path) -> None:
    chrome = _chrome_executable()
    playwright = Path("web/node_modules/playwright")
    if chrome is None or not playwright.is_dir():
        return
    providers = next(doc for doc in built_documents() if doc.entry_id.endswith("_providers"))
    html_path = tmp_path / "providers.html"
    html_path.write_text(providers.html, encoding="utf-8")
    script = tmp_path / "measure.cjs"
    script.write_text(
        "const { chromium } = require(require('path').resolve('web/node_modules/playwright'));\n"
        "const file = process.argv[2];\n"
        "const chrome = process.argv[3];\n"
        "const widths = [320, 390, 768, 1440];\n"
        "(async () => {\n"
        "  const browser = await chromium.launch({ executablePath: chrome, headless: true });\n"
        "  const report = [];\n"
        "  for (const w of widths) {\n"
        "    const page = await browser.newPage({ viewport: { width: w, height: 900 } });\n"
        "    await page.goto('file:///' + file.replace(/\\\\/g, '/'));\n"
        "    const m = await page.evaluate(() => ({\n"
        "      cw: document.documentElement.clientWidth,\n"
        "      sw: document.documentElement.scrollWidth,\n"
        "      bcw: document.body.clientWidth,\n"
        "      bsw: document.body.scrollWidth,\n"
        "    }));\n"
        "    report.push({ w, ...m });\n"
        "    await page.close();\n"
        "  }\n"
        "  await browser.close();\n"
        "  process.stdout.write(JSON.stringify(report));\n"
        "})().catch((err) => { console.error(err); process.exit(1); });\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        ["node", str(script), str(html_path.resolve()), str(chrome)],
        check=False,
        capture_output=True,
        text=True,
        cwd=str(Path.cwd()),
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert [row["w"] for row in report] == [320, 390, 768, 1440]
    for row in report:
        assert row["cw"] == row["sw"] == row["w"]
        assert row["bcw"] == row["bsw"] == row["w"]


def test_welcome_switchers_are_complete_radio_groups() -> None:
    blob = "\n".join(doc.html for doc in built_documents())
    assert blob.count('role="radiogroup"') == 4
    assert "tablist" not in blob
    assert 'role="tab"' not in blob
    assert "tabpanel" not in blob
    assert "label:has(:focus-visible)" in blob
    assert "label:has(:checked)" in blob
    assert "input:focus-visible + .tabs" not in blob
    assert re.search(
        r'role="radiogroup"[^>]*>\s*<label[^>]*>\s*<input type="radio"',
        blob,
    )
    for label in ("此刻最想做的事", "工作流", "服务商", "请求怎么走一遭"):
        assert f'aria-label="{label}"' in blob


def test_v1_digest_table_is_complete_evidence() -> None:
    assert set(V1_HTML_DIGESTS) == {doc.entry_id for doc in built_documents()}
    for digest in V1_HTML_DIGESTS.values():
        assert re.fullmatch(r"[0-9a-f]{64}", digest)
    v3 = welcome_html_digests()
    for entry_id, digest in V1_HTML_DIGESTS.items():
        assert digest != v3[entry_id]
    assert set(V2_HTML_DIGESTS) == {doc.entry_id for doc in built_documents()}
    for entry_id, digest in V2_HTML_DIGESTS.items():
        assert re.fullmatch(r"[0-9a-f]{64}", digest)
        assert digest != v3[entry_id]


def test_new_library_seeds_welcome_pack_once(tmp_path: Path) -> None:
    store = CreativeLibraryStore(tmp_path)
    first = store.list_tree()
    second = store.list_tree()
    folder = _welcome_folder(first)
    assert folder["title"] == FOLDER_TITLE
    assert folder["kind"] == "folder"
    children = folder["children"]
    assert len(children) == 10
    assert {child["kind"] for child in children} == {"html"}
    assert [child["id"] for child in children] == [doc.entry_id for doc in built_documents()]
    assert second["total"] == first["total"]
    overview = store.get_entry(children[0]["id"])
    assert overview is not None
    assert 'data-welcome-pack="v3"' in overview["content"]
    assert overview["preview_scripts"] is True
    assert overview["sha256"] == welcome_html_digests()[overview["id"]]
    assert all(child["preview_scripts"] is True for child in children)
    meta = _meta(store)
    assert meta is not None
    assert meta["status"] == "applied"
    assert meta["version"] == 3


def test_upgrade_existing_library_receives_pack_without_touching_user_files(
    tmp_path: Path,
) -> None:
    store = CreativeLibraryStore(tmp_path)
    note = store.create_entry(kind="markdown", title="已有笔记", content="keep me")
    tree = store.list_tree()
    titles = {item["title"] for item in tree["items"]}
    assert "已有笔记" in titles
    assert FOLDER_TITLE in titles
    loaded = store.get_entry(note["id"])
    assert loaded is not None
    assert loaded["content"] == "keep me"
    store.update_entry(note["id"], {"content": "user edit"})
    store.list_tree()
    assert store.get_entry(note["id"])["content"] == "user edit"


def test_same_title_collision_does_not_overwrite(tmp_path: Path) -> None:
    store = CreativeLibraryStore(tmp_path)
    user_folder = store.create_entry(kind="folder", title=FOLDER_TITLE)
    inner = store.create_entry(
        kind="html",
        title=built_documents()[0].title,
        parent_id=user_folder["id"],
        content="<p>mine</p>",
    )
    tree = store.list_tree()
    roots = [item for item in tree["items"] if item["title"] == FOLDER_TITLE]
    assert len(roots) == 1
    assert roots[0]["id"] == user_folder["id"]
    assert store.get_entry(FOLDER_ID) is None
    loaded = store.get_entry(inner["id"])
    assert loaded is not None
    assert loaded["content"] == "<p>mine</p>"
    meta = _meta(store)
    assert meta is not None
    assert meta["status"] == "applied"


def test_user_edits_are_not_rewritten_on_later_list(tmp_path: Path) -> None:
    store = CreativeLibraryStore(tmp_path)
    overview_id = built_documents()[0].entry_id
    store.list_tree()
    store.update_entry(overview_id, {"content": "<p>我改过了</p>"})
    store.list_tree()
    loaded = store.get_entry(overview_id)
    assert loaded is not None
    assert loaded["content"] == "<p>我改过了</p>"
    assert loaded["preview_scripts"] is False


def test_deleted_welcome_pack_does_not_return(tmp_path: Path) -> None:
    store = CreativeLibraryStore(tmp_path)
    store.list_tree()
    assert store.delete_entry(FOLDER_ID) is True
    again = store.list_tree()
    assert all(item["id"] != FOLDER_ID for item in again["items"])
    assert all(item["title"] != FOLDER_TITLE for item in again["items"])
    assert store.get_entry(FOLDER_ID) is None
    assert store.get_entry(built_documents()[0].entry_id) is None
    meta = _meta(store)
    assert meta is not None
    assert meta["status"] == "applied"


def test_legacy_asset_import_still_runs_before_welcome_seed(tmp_path: Path) -> None:
    store = CreativeLibraryStore(tmp_path)
    store.create_text_asset(title="Old note", content="keep me")
    tree = store.list_tree()
    titles = [item["title"] for item in tree["items"]]
    assert titles.count("Imported assets") == 1
    assert FOLDER_TITLE in titles


def test_concurrent_list_tree_does_not_duplicate_welcome(tmp_path: Path) -> None:
    stores = [CreativeLibraryStore(tmp_path) for _ in range(4)]

    def load(store: CreativeLibraryStore) -> dict:
        return store.list_tree()

    with ThreadPoolExecutor(max_workers=8) as pool:
        trees = list(pool.map(load, stores + stores))
    counts = []
    for tree in trees:
        matches = [item for item in tree["items"] if item["title"] == FOLDER_TITLE]
        counts.append(len(matches))
        if matches:
            assert matches[0]["id"] == FOLDER_ID
            assert len(matches[0]["children"]) == 10
    assert set(counts) == {1}
    db = sqlite3.connect(stores[0].db_path)
    try:
        live = db.execute(
            "SELECT COUNT(*) FROM entries WHERE title=? AND deleted_at IS NULL",
            (FOLDER_TITLE,),
        ).fetchone()[0]
        pages = db.execute(
            "SELECT COUNT(*) FROM entries WHERE parent_id=? AND deleted_at IS NULL",
            (FOLDER_ID,),
        ).fetchone()[0]
    finally:
        db.close()
    assert live == 1
    assert pages == 10


def test_welcome_preview_scripts_require_stable_id_and_exact_hash(tmp_path: Path) -> None:
    store = CreativeLibraryStore(tmp_path)
    store.list_tree()
    original = built_documents()[0]
    loaded = store.get_entry(original.entry_id)
    assert loaded is not None
    assert loaded["preview_scripts"] is True
    assert loaded["sha256"] == welcome_html_digests()[original.entry_id]

    edited = store.update_entry(original.entry_id, {"content": original.html + " "})
    assert edited["preview_scripts"] is False
    store.list_tree()
    after_seed = store.get_entry(original.entry_id)
    assert after_seed is not None
    assert after_seed["content"] == original.html + " "
    assert after_seed["preview_scripts"] is False

    restored = store.update_entry(original.entry_id, {"content": original.html})
    assert restored["preview_scripts"] is True
    assert restored["sha256"] == welcome_html_digests()[original.entry_id]


def test_forged_welcome_marker_or_title_does_not_unlock_preview_scripts(tmp_path: Path) -> None:
    store = CreativeLibraryStore(tmp_path)
    original = built_documents()[0]
    clone = store.create_entry(
        kind="html",
        title=original.title,
        content=original.html,
    )
    marked = store.create_entry(
        kind="html",
        title=FOLDER_TITLE,
        content='<!doctype html><html data-welcome-pack="v3"><body>nope</body></html>',
    )
    note = store.create_entry(kind="markdown", title="note", content="# hi")
    assert clone["id"] != original.entry_id
    assert clone["preview_scripts"] is False
    assert marked["preview_scripts"] is False
    assert note["preview_scripts"] is False
    assert html_preview_scripts(entry_id=original.entry_id, kind="html", sha256="ab") is False
    assert (
        html_preview_scripts(
            entry_id="lib_entry_forged",
            kind="html",
            sha256=welcome_html_digests()[original.entry_id],
        )
        is False
    )


def _plant_v1_library(store: CreativeLibraryStore, *, edited_id: str | None = None) -> str:
    v1_body = "<p>v1-original-body</p>"
    now = time.time()
    db = sqlite3.connect(store.db_path)
    try:
        db.execute(
            """INSERT INTO entries
               (id,parent_id,kind,title,mime,content,relative_path,size_bytes,sha256,sort_order,created_at,updated_at,deleted_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
            (
                FOLDER_ID,
                None,
                "folder",
                V1_FOLDER_TITLE,
                "",
                "",
                "",
                0,
                "",
                0,
                now,
                now,
            ),
        )
        for index, doc in enumerate(built_documents()):
            body = "<p>user-edited-v1</p>" if doc.entry_id == edited_id else v1_body
            digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
            db.execute(
                """INSERT INTO entries
                   (id,parent_id,kind,title,mime,content,relative_path,size_bytes,sha256,sort_order,created_at,updated_at,deleted_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
                (
                    doc.entry_id,
                    FOLDER_ID,
                    "html",
                    f"v1-title-{index}",
                    "text/html",
                    body,
                    "",
                    len(body.encode("utf-8")),
                    digest,
                    index,
                    now,
                    now,
                ),
            )
        db.execute(
            "INSERT INTO library_meta(key, value, updated_at) VALUES (?,?,?)",
            (V1_SEED_KEY, json.dumps({"version": 1, "status": "applied"}), now),
        )
        db.commit()
    finally:
        db.close()
    return v1_body


def test_v1_unedited_rows_upgrade_to_v3_and_edited_rows_are_kept(
    tmp_path: Path, monkeypatch
) -> None:
    store = CreativeLibraryStore(tmp_path)
    docs = built_documents()
    edited_id = docs[3].entry_id
    v1_body = _plant_v1_library(store, edited_id=edited_id)
    digest = hashlib.sha256(v1_body.encode("utf-8")).hexdigest()
    monkeypatch.setattr(
        "knorvia.services.creative_library.welcome.seed.V1_HTML_DIGESTS",
        {doc.entry_id: digest for doc in docs},
    )
    tree = store.list_tree()
    folder = _welcome_folder(tree)
    assert folder["title"] == FOLDER_TITLE
    for doc in docs:
        loaded = store.get_entry(doc.entry_id)
        assert loaded is not None
        if doc.entry_id == edited_id:
            assert loaded["content"] == "<p>user-edited-v1</p>"
            assert loaded["preview_scripts"] is False
        else:
            assert loaded["content"] == doc.html
            assert loaded["preview_scripts"] is True
    meta = _meta(store)
    assert meta is not None
    assert meta["version"] == 3
    assert edited_id in meta["skipped"]
    assert docs[0].entry_id in meta["updated"]


def test_v2_unedited_rows_upgrade_to_v3_and_edited_rows_are_kept(
    tmp_path: Path, monkeypatch
) -> None:
    store = CreativeLibraryStore(tmp_path)
    docs = built_documents()
    edited_id = docs[6].entry_id
    legacy_body = _plant_v1_library(store, edited_id=edited_id)
    now = time.time()
    db = sqlite3.connect(store.db_path)
    try:
        db.execute("DELETE FROM library_meta WHERE key=?", (V1_SEED_KEY,))
        db.execute(
            "INSERT INTO library_meta(key, value, updated_at) VALUES (?,?,?)",
            (V2_SEED_KEY, json.dumps({"version": 2, "status": "applied"}), now),
        )
        db.commit()
    finally:
        db.close()
    digest = hashlib.sha256(legacy_body.encode("utf-8")).hexdigest()
    monkeypatch.setattr(
        "knorvia.services.creative_library.welcome.seed.V2_HTML_DIGESTS",
        {doc.entry_id: digest for doc in docs},
    )
    store.list_tree()
    for doc in docs:
        loaded = store.get_entry(doc.entry_id)
        assert loaded is not None
        if doc.entry_id == edited_id:
            assert loaded["content"] == "<p>user-edited-v1</p>"
            assert loaded["preview_scripts"] is False
        else:
            assert loaded["content"] == doc.html
            assert loaded["preview_scripts"] is True
    meta = _meta(store)
    assert meta is not None
    assert meta["version"] == 3
    assert meta["v2_key"] == V2_SEED_KEY
    assert edited_id in meta["skipped"]


def test_deleted_v1_folder_is_not_resurrected_by_v3(tmp_path: Path) -> None:
    store = CreativeLibraryStore(tmp_path)
    now = time.time()
    db = sqlite3.connect(store.db_path)
    try:
        db.execute(
            """INSERT INTO entries
               (id,parent_id,kind,title,mime,content,relative_path,size_bytes,sha256,sort_order,created_at,updated_at,deleted_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                FOLDER_ID,
                None,
                "folder",
                V1_FOLDER_TITLE,
                "",
                "",
                "",
                0,
                "",
                0,
                now,
                now,
                now,
            ),
        )
        db.execute(
            "INSERT INTO library_meta(key, value, updated_at) VALUES (?,?,?)",
            (V1_SEED_KEY, json.dumps({"version": 1, "status": "applied"}), now),
        )
        db.commit()
    finally:
        db.close()
    tree = store.list_tree()
    assert all(item["id"] != FOLDER_ID for item in tree["items"])
    assert store.get_entry(built_documents()[0].entry_id) is None
    meta = _meta(store)
    assert meta is not None
    assert meta["reason"] == "deleted"
    assert meta["version"] == 3
