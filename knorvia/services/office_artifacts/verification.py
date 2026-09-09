"""Package-level verification for the Office artifact runtime.

After any mutation the candidate bytes must prove, before the revision is
advanced, that:

- the ZIP container is structurally valid (CRC test, required parts present);
- the file re-opens with the format's native reader;
- the mutated targets read back with the expected values;
- every ZIP entry outside the declared allowed-change list is byte-identical
  (decompressed SHA-256) to the original package.
"""

from __future__ import annotations

import hashlib
import io
from typing import Iterable
import zipfile

from knorvia.services.office_artifacts.contracts import VerificationError

REQUIRED_XLSX_PARTS = ("[Content_Types].xml", "xl/workbook.xml")
CONTENT_TYPES_PART = "[Content_Types].xml"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def zip_entry_hashes(data: bytes) -> dict[str, str]:
    """Decompressed-content SHA-256 for every entry, in package order."""
    entries: dict[str, str] = {}
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        for info in bundle.infolist():
            entries[info.filename] = sha256_hex(bundle.read(info.filename))
    return entries


def verify_package_relations(data: bytes) -> None:
    """Every internal reference must point at a part that exists.

    A ZIP can pass its CRC checks and still carry a relationship or
    content-type override for a part that is gone; Excel then opens the file
    with a repair prompt. That counts as a failed edit here.
    """
    from lxml import etree

    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        names = set(bundle.namelist())
        manifests = {
            info.filename: bundle.read(info.filename)
            for info in bundle.infolist()
            if info.filename.endswith(".rels")
            or info.filename == CONTENT_TYPES_PART
        }

    for name, payload in manifests.items():
        try:
            root = etree.fromstring(payload)
        except etree.XMLSyntaxError as exc:
            raise VerificationError(f"package manifest {name!r} is not parseable: {exc}") from exc
        for element in root:
            tag = etree.QName(element).localname
            if tag == "Override":
                part = str(element.get("PartName") or "").lstrip("/")
                if part and part not in names:
                    raise VerificationError(
                        f"{name} declares a content type for {part!r}, which is not in the "
                        "package"
                    )
            elif tag == "Relationship":
                if (element.get("TargetMode") or "").lower() == "external":
                    continue
                target = str(element.get("Target") or "")
                if not target or target.startswith("#"):
                    continue
                part = resolve_relationship_target(name, target)
                if part not in names:
                    raise VerificationError(
                        f"{name} references {part!r}, which is not in the package"
                    )


def resolve_relationship_target(rels_name: str, target: str) -> str:
    """Resolve an OPC relationship target against its source part's directory."""
    import posixpath

    if target.startswith("/"):
        return posixpath.normpath(target.lstrip("/"))
    # "xl/_rels/workbook.xml.rels" describes "xl/workbook.xml".
    owner = posixpath.dirname(posixpath.dirname(rels_name))
    return posixpath.normpath(posixpath.join(owner, target))


def verify_zip_structure(data: bytes, *, required_parts: Iterable[str] = ()) -> None:
    """CRC test + presence of the parts the format cannot live without."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as bundle:
            bad = bundle.testzip()
            if bad is not None:
                raise VerificationError(f"ZIP entry {bad!r} fails its CRC check")
            names = set(bundle.namelist())
    except zipfile.BadZipFile as exc:
        raise VerificationError("candidate file is not a valid ZIP container") from exc
    missing = [part for part in required_parts if part not in names]
    if missing:
        raise VerificationError(f"required package parts missing: {', '.join(missing)}")


def compute_untouched_violations(
    original: bytes, candidate: bytes, allowed_changed: Iterable[str]
) -> list[str]:
    """Names of entries that changed but are not in the allowed list."""
    before = zip_entry_hashes(original)
    after = zip_entry_hashes(candidate)
    allowed = set(allowed_changed)
    violations: list[str] = []
    for name, digest in before.items():
        if name in allowed:
            continue
        if name not in after or after[name] != digest:
            violations.append(name)
    for name in after:
        if name not in before and name not in allowed:
            violations.append(name)
    return violations


def allowed_changed_parts(original: bytes, candidate: bytes) -> list[str]:
    before = zip_entry_hashes(original)
    after = zip_entry_hashes(candidate)
    changed = [name for name, digest in before.items() if after.get(name) != digest]
    changed.extend(name for name in after if name not in before)
    return sorted(changed)
