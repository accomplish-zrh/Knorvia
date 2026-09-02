"""Co-Writer paper citations stay local to the draft."""

from knorvia.co_writer.paper_chat import extract_paper_citations


def test_extracts_headings_links_and_numbered_refs() -> None:
    md = """
# Proposal

## Related work

See [Knorvia](https://example.com/knorvia) for the stack.

[1] Turing, A. Computing machinery, 1950.
"""
    cites = extract_paper_citations(md)
    titles = [c["title"] for c in cites]
    assert "Proposal" in titles
    assert "Related work" in titles
    assert any(c["source"].startswith("http") for c in cites)
    assert any(c["source"] == "reference" for c in cites)


def test_empty_draft_has_no_citations() -> None:
    assert extract_paper_citations("") == []
    assert extract_paper_citations("   \n") == []
