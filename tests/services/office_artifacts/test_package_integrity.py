"""OOXML package integrity: no part may be removed and still be referenced.

Writing formulas drops the stale ``xl/calcChain.xml`` so Excel rebuilds it, but
a dropped part leaves its relationship and content-type override dangling
behind. The ZIP is still structurally valid then, so only a package-relation
check catches it — and a workbook Excel offers to "repair" is not a successful
edit.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
import zipfile

from lxml import etree
import pytest

from knorvia.services.office_artifacts.adapters import xlsx_adapter
from knorvia.services.office_artifacts.contracts import VerificationError
from knorvia.services.office_artifacts.service import OfficeArtifactService
from knorvia.services.office_artifacts.verification import verify_package_relations

CONTENT_TYPES = "[Content_Types].xml"
WORKBOOK_RELS = "xl/_rels/workbook.xml.rels"
CALC_CHAIN = "xl/calcChain.xml"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def _with_calc_chain(data: bytes) -> bytes:
    """Pretend Excel authored this file: add a calcChain part and its refs."""
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        names = bundle.namelist()
        entries = {name: bundle.read(name) for name in names}

    entries[CALC_CHAIN] = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        b'<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        b'<c r="B2" i="1"/></calcChain>'
    )
    rels = etree.fromstring(entries[WORKBOOK_RELS])
    etree.SubElement(
        rels,
        f"{{{REL_NS}}}Relationship",
        {
            "Id": "rIdCalc",
            "Type": "http://schemas.openxmlformats.org/officeDocument/2006/"
            "relationships/calcChain",
            "Target": "calcChain.xml",
        },
    )
    entries[WORKBOOK_RELS] = etree.tostring(rels, xml_declaration=True, encoding="UTF-8")

    types = etree.fromstring(entries[CONTENT_TYPES])
    etree.SubElement(
        types,
        f"{{{CT_NS}}}Override",
        {
            "PartName": "/xl/calcChain.xml",
            "ContentType": "application/vnd.openxmlformats-officedocument."
            "spreadsheetml.calcChain+xml",
        },
    )
    entries[CONTENT_TYPES] = etree.tostring(types, xml_declaration=True, encoding="UTF-8")

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in [*names, *[n for n in entries if n not in names]]:
            bundle.writestr(name, entries[name])
    return out.getvalue()


def _imported_draft(tmp_path: Path, data: bytes) -> tuple[OfficeArtifactService, str, str]:
    service = OfficeArtifactService(task_dir=tmp_path, workspace_dir=tmp_path / "exec")
    draft_id = service.store.create_draft()
    artifact_id = service.store.add_artifact(
        draft_id,
        filename="book.xlsx",
        mime="",
        kind="xlsx",
        origin_kind="attachment",
        origin_ref="attachment:book.xlsx",
        data=data,
        origin_base_hash=hashlib.sha256(data).hexdigest(),
    )
    return service, draft_id, artifact_id


def _names(data: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        return bundle.namelist()


def _read(data: bytes, name: str) -> bytes:
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        return bundle.read(name)


def test_the_authored_fixture_does_reference_the_calc_chain() -> None:
    data = _with_calc_chain(xlsx_adapter.create_generated_xlsx("Data"))
    assert CALC_CHAIN in _names(data)
    assert b"calcChain" in _read(data, WORKBOOK_RELS)
    assert b"/xl/calcChain.xml" in _read(data, CONTENT_TYPES)
    verify_package_relations(data)  # a complete package must pass


def test_writing_a_formula_drops_the_calc_chain_and_every_reference_to_it(
    tmp_path: Path,
) -> None:
    source = _with_calc_chain(xlsx_adapter.create_generated_xlsx("Data"))
    service, draft_id, artifact_id = _imported_draft(tmp_path, source)

    result = service.apply_operations(
        draft_id,
        artifact_id,
        0,
        [{"op": "set_formula", "sheet": "Data", "cell": "B2", "formula": "=1+1"}],
        actor="tester",
    )

    assert result["mutated"] is True
    current = service.store.current_bytes(draft_id, artifact_id)
    assert CALC_CHAIN not in _names(current)
    assert b"calcChain" not in _read(current, WORKBOOK_RELS), (
        "workbook.xml.rels still points at a part that is gone"
    )
    assert b"calcChain" not in _read(current, CONTENT_TYPES), (
        "[Content_Types].xml still overrides a part that is gone"
    )
    verify_package_relations(current)


def test_other_relationships_survive_the_cleanup(tmp_path: Path) -> None:
    source = _with_calc_chain(xlsx_adapter.create_generated_xlsx("Data"))
    before = etree.fromstring(_read(source, WORKBOOK_RELS))
    before_ids = {rel.get("Id") for rel in before}
    service, draft_id, artifact_id = _imported_draft(tmp_path, source)

    service.apply_operations(
        draft_id,
        artifact_id,
        0,
        [{"op": "set_formula", "sheet": "Data", "cell": "B2", "formula": "=2+2"}],
        actor="tester",
    )

    after = etree.fromstring(
        _read(service.store.current_bytes(draft_id, artifact_id), WORKBOOK_RELS)
    )
    after_ids = {rel.get("Id") for rel in after}
    assert before_ids - after_ids == {"rIdCalc"}
    assert before_ids & after_ids == before_ids - {"rIdCalc"}


def test_package_relation_check_rejects_a_dangling_reference() -> None:
    complete = _with_calc_chain(xlsx_adapter.create_generated_xlsx("Data"))
    with zipfile.ZipFile(io.BytesIO(complete)) as bundle:
        names = [n for n in bundle.namelist() if n != CALC_CHAIN]
        entries = {name: bundle.read(name) for name in names}
    stripped = io.BytesIO()
    with zipfile.ZipFile(stripped, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in names:
            bundle.writestr(name, entries[name])

    with pytest.raises(VerificationError, match="calcChain"):
        verify_package_relations(stripped.getvalue())


def test_service_verification_rejects_a_package_with_dangling_references(
    tmp_path: Path,
) -> None:
    source = _with_calc_chain(xlsx_adapter.create_generated_xlsx("Data"))
    service, draft_id, artifact_id = _imported_draft(tmp_path, source)
    with zipfile.ZipFile(io.BytesIO(source)) as bundle:
        entries = {n: bundle.read(n) for n in bundle.namelist() if n != CALC_CHAIN}
    stripped = io.BytesIO()
    with zipfile.ZipFile(stripped, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, payload in entries.items():
            bundle.writestr(name, payload)

    with pytest.raises(VerificationError):
        service._verify(
            original_bytes=source,
            candidate_bytes=stripped.getvalue(),
            imported=True,
            operations=[],
            allowed_parts=[CALC_CHAIN],
        )
