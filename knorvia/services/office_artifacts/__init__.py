"""Office artifact runtime v2 (XLSX-first).

Strict, transactional, agent-native editing for Office artifacts. See
``ARCHITECTURE.md`` (next to this package) for the architecture and the fail-closed
matrix.
"""

from knorvia.services.office_artifacts.contracts import (
    ApplyBatchRequest,
    ArtifactNotFoundError,
    DraftStateError,
    InvalidOperationError,
    MergeConflictError,
    OfficeArtifactError,
    RevisionConflictError,
    SourceRef,
    UnsupportedOperationError,
    VerificationError,
    parse_operations,
    parse_source_ref,
)
from knorvia.services.office_artifacts.service import OfficeArtifactService
from knorvia.services.office_artifacts.store import OfficeArtifactStore

__all__ = [
    "ApplyBatchRequest",
    "ArtifactNotFoundError",
    "DraftStateError",
    "InvalidOperationError",
    "MergeConflictError",
    "OfficeArtifactError",
    "OfficeArtifactService",
    "OfficeArtifactStore",
    "RevisionConflictError",
    "SourceRef",
    "UnsupportedOperationError",
    "VerificationError",
    "parse_operations",
    "parse_source_ref",
]
