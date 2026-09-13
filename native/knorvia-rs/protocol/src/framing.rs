use std::io::{BufRead, Write};

use crate::{MAX_FRAME_BYTES, WireError};
const MAX_HEADER_BYTES: usize = 8192;

/// Encode one LSP-style frame: `Content-Length: N\r\n\r\n<body>`.
pub fn encode_frame(body: &str) -> Vec<u8> {
    let bytes = body.as_bytes();
    let header = format!("Content-Length: {}\r\n\r\n", bytes.len());
    let mut out = Vec::with_capacity(header.len() + bytes.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(bytes);
    out
}

pub fn write_frame<W: Write>(mut w: W, body: &str) -> Result<(), WireError> {
    if body.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge(body.len()));
    }
    w.write_all(&encode_frame(body))?;
    w.flush()?;
    Ok(())
}

/// Read one frame. Rejects missing Content-Length and oversized bodies.
pub fn read_frame<R: BufRead>(mut r: R) -> Result<String, WireError> {
    let mut headers = Vec::new();
    let mut header_bytes = 0;
    loop {
        let mut line = String::new();
        let n = std::io::Read::take(&mut r, (MAX_HEADER_BYTES - header_bytes + 1) as u64)
            .read_line(&mut line)?;
        header_bytes += n;
        if header_bytes > MAX_HEADER_BYTES {
            return Err(WireError::InvalidHeader(
                "frame headers exceed 8192 bytes".into(),
            ));
        }
        if n == 0 {
            return Err(WireError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "eof before frame headers completed",
            )));
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        headers.push(line);
    }
    let mut length: Option<usize> = None;
    for h in &headers {
        let lower = h.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            if length.is_some() {
                return Err(WireError::InvalidHeader("duplicate Content-Length".into()));
            }
            let rest = rest.trim();
            let rest = rest.trim_end_matches(['\r', '\n']);
            length = Some(
                rest.parse::<usize>()
                    .map_err(|_| WireError::InvalidHeader(format!("bad Content-Length: {h:?}")))?,
            );
        }
    }
    let length = length.ok_or_else(|| WireError::InvalidHeader("missing Content-Length".into()))?;
    if length > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge(length));
    }
    let mut buf = vec![0u8; length];
    r.read_exact(&mut buf)?;
    String::from_utf8(buf).map_err(|_| WireError::Utf8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trip_frame() {
        let body = r#"{"jsonrpc":"2.0","id":"1","method":"system/health"}"#;
        let encoded = encode_frame(body);
        assert!(encoded.starts_with(b"Content-Length: "));
        assert!(
            !encoded.starts_with(b"{"),
            "stdout must be framed, not raw json"
        );
        let decoded = read_frame(Cursor::new(&encoded)).unwrap();
        assert_eq!(decoded, body);
    }

    #[test]
    fn rejects_missing_length() {
        let err = read_frame(Cursor::new(b"\r\n{}\n")).unwrap_err();
        match err {
            WireError::InvalidHeader(h) => assert!(h.contains("Content-Length")),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn rejects_oversize() {
        let header = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_BYTES + 1);
        let err = read_frame(Cursor::new(header.as_bytes())).unwrap_err();
        match err {
            WireError::FrameTooLarge(n) => assert_eq!(n, MAX_FRAME_BYTES + 1),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn rejects_unterminated_unbounded_headers_and_duplicate_lengths() {
        let huge = vec![b'x'; MAX_HEADER_BYTES + 100];
        let mut input = Cursor::new(huge);
        assert!(matches!(
            read_frame(&mut input),
            Err(WireError::InvalidHeader(_))
        ));
        assert_eq!(input.position(), (MAX_HEADER_BYTES + 1) as u64);
        let duplicate = b"Content-Length: 0\r\nContent-Length: 2\r\n\r\n{}";
        assert!(matches!(
            read_frame(Cursor::new(duplicate)),
            Err(WireError::InvalidHeader(_))
        ));
    }
    #[test]
    fn rejects_oversized_output_before_writing_any_bytes() {
        let mut written = Vec::new();
        assert!(matches!(
            write_frame(&mut written, &"x".repeat(MAX_FRAME_BYTES + 1)),
            Err(WireError::FrameTooLarge(_))
        ));
        assert!(written.is_empty());
    }
}
