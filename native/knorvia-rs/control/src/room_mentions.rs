//! A12: structured `@`-mention parsing and identity resolution.
//!
//! The resolver is deliberately pure: message text plus the room's members
//! and the global bot catalog in, an explainable [`MentionPlan`] out. Nothing
//! here starts a turn or mutates the store, so a plan can be checked item by
//! item in a fixture without a Kernel, and `room/send` stays free to own its
//! admission transaction around it.

use knorvia_protocol::{Mention, MentionCandidate, MentionOutcome, MentionPlan, MentionSource};
use knorvia_store::{BotProfile, RoomMember};
use std::collections::{HashMap, HashSet};

/// `@bot:<id>` and `@[label](bot:<id>)` bind straight to an identity.
const EXPLICIT_ID_PREFIX: &str = "bot:";

fn is_name_char(c: char) -> bool {
    // Unicode alphanumerics keep CJK names addressable; `_`, `-` and `.` are
    // ordinary handle characters. Whitespace and other punctuation end a run.
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.')
}

/// Case-fold and collapse whitespace so `@CLI  teammate`, `@cli teammate` and
/// a bot literally named `CLI teammate` agree.
fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn contains_byte(ranges: &[(usize, usize)], at: usize) -> bool {
    ranges.iter().any(|(start, end)| at >= *start && at < *end)
}

fn line_fence(line: &str) -> Option<(char, usize)> {
    let body = line.trim_start_matches([' ', '\t']);
    let marker = body.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let width = body.chars().take_while(|c| *c == marker).count();
    (width >= 3).then_some((marker, width))
}

/// The name-token run at `at`, with sentence-final punctuation trimmed so
/// `@Alice.` still names Alice. Returns the text and its end byte offset.
fn name_run_at(content: &str, at: usize) -> (String, usize) {
    let run: String = content[at..]
        .chars()
        .take_while(|c| is_name_char(*c))
        .collect();
    let kept = run.trim_end_matches(['.', '-', '_']).len();
    let text: String = run.chars().take(kept).collect();
    let end = at + text.len();
    (text, end)
}

/// Byte ranges the parser must treat as literal text: fenced blocks and
/// inline code spans. Telling somebody "use `@Alice`" therefore never
/// dispatches Alice.
fn inert_ranges(content: &str) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut fences: Vec<(usize, usize)> = Vec::new();
    let mut offset = 0usize;
    let mut open: Option<(usize, char, usize)> = None;
    for line in content.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        let body = line.trim_end_matches(['\r', '\n']);
        if open.is_none() {
            let left = body.trim_start_matches([' ', '\t']);
            if let Some(after) = left.strip_prefix('>')
                && (after.is_empty() || after.starts_with([' ', '\t']))
            {
                // An explicit Markdown quote is reference material. A user
                // can paste a prior `@Alice` instruction without replaying
                // it; a mention on a later non-quoted line still works.
                ranges.push((start, offset));
            }
        }
        match (open, line_fence(body)) {
            (None, Some((marker, width))) => open = Some((start, marker, width)),
            (Some((open_start, open_marker, open_width)), Some((marker, width)))
                if marker == open_marker && width >= open_width =>
            {
                ranges.push((open_start, offset));
                fences.push((open_start, offset));
                open = None;
            }
            _ => {}
        }
    }
    if let Some((open_start, _, _)) = open {
        // An unclosed fence keeps everything after it inert: a truncated
        // code example must not summon a bot either.
        ranges.push((open_start, content.len()));
        fences.push((open_start, content.len()));
    }

    let bytes = content.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'`' || contains_byte(&fences, index) {
            index += 1;
            continue;
        }
        let run_start = index;
        while index < bytes.len() && bytes[index] == b'`' {
            index += 1;
        }
        let width = index - run_start;
        let mut cursor = index;
        let mut closed = None;
        while cursor < bytes.len() {
            if contains_byte(&fences, cursor) {
                break;
            }
            if bytes[cursor] != b'`' {
                cursor += 1;
                continue;
            }
            let close_start = cursor;
            while cursor < bytes.len() && bytes[cursor] == b'`' {
                cursor += 1;
            }
            if cursor - close_start == width {
                closed = Some(cursor);
                break;
            }
        }
        if let Some(end) = closed {
            ranges.push((run_start, end));
            index = end;
        }
    }

    ranges.sort();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.0 <= last.1 => last.1 = last.1.max(range.1),
            _ => merged.push(range),
        }
    }
    merged
}

/// The catalog a token can be resolved against, with the member set kept
/// separate so a member mention and a cross-room target never share a rule.
pub(crate) struct MentionIndex<'a> {
    by_id: HashMap<&'a str, &'a BotProfile>,
    by_name: HashMap<String, Vec<&'a BotProfile>>,
    members: HashSet<&'a str>,
}

impl<'a> MentionIndex<'a> {
    pub fn new(members: &'a [RoomMember], bots: &'a [BotProfile]) -> Self {
        let mut by_name: HashMap<String, Vec<&'a BotProfile>> = HashMap::new();
        for bot in bots {
            by_name.entry(normalize(&bot.name)).or_default().push(bot);
        }
        Self {
            by_id: bots.iter().map(|bot| (bot.id.as_str(), bot)).collect(),
            by_name,
            members: members
                .iter()
                .map(|member| member.bot_id.as_str())
                .collect(),
        }
    }

    fn is_member(&self, bot: &BotProfile) -> bool {
        self.members.contains(bot.id.as_str())
    }

    fn candidates(&self, bots: &[&'a BotProfile]) -> Vec<MentionCandidate> {
        let mut seen = HashSet::new();
        bots.iter()
            .filter(|bot| seen.insert(bot.id.as_str()))
            .map(|bot| MentionCandidate {
                bot_id: bot.id.clone(),
                name: bot.name.clone(),
                member: self.is_member(bot),
            })
            .collect()
    }

    /// Reproduces a whole normalized name at `at`, word by word, demanding
    /// real token boundaries so `@Anna` can never match the bot `Ann`.
    fn match_words(&self, name: &str, content: &str, at: usize) -> Option<usize> {
        let mut cursor = at;
        for (position, word) in name.split(' ').enumerate() {
            if position > 0 {
                let before = cursor;
                while let Some(c) = content[cursor..].chars().next() {
                    if !c.is_whitespace() {
                        break;
                    }
                    cursor += c.len_utf8();
                }
                if cursor == before {
                    return None;
                }
            }
            let (run, end) = name_run_at(content, cursor);
            if run.is_empty() || run.to_lowercase() != word {
                return None;
            }
            cursor = end;
        }
        Some(cursor)
    }

    /// Longest bare-name match starting just after an `@`. Longest wins so
    /// `@研究 助手` reaches the two-word agent instead of the one-word one.
    fn match_bare(&self, content: &str, at: usize) -> Option<(usize, Vec<&'a BotProfile>)> {
        let (head_text, _) = name_run_at(content, at);
        if head_text.is_empty() {
            return None;
        }
        let head = head_text.to_lowercase();
        let mut best_end = 0usize;
        let mut best: Vec<&'a BotProfile> = Vec::new();
        for (name, bots) in &self.by_name {
            if name.split(' ').next() != Some(head.as_str()) {
                continue;
            }
            let Some(end) = self.match_words(name, content, at) else {
                continue;
            };
            match end.cmp(&best_end) {
                std::cmp::Ordering::Greater => {
                    best_end = end;
                    best.clone_from(bots);
                }
                std::cmp::Ordering::Equal => best.extend(bots.iter().copied()),
                std::cmp::Ordering::Less => {}
            }
        }
        (best_end > 0).then_some((best_end, best))
    }
}

struct Token {
    start: usize,
    end: usize,
    source: MentionSource,
    /// Claimed bot id for explicit forms, display text for name forms.
    identity: String,
}

fn explicit_id_run(content: &str, at: usize) -> Option<(usize, String)> {
    let end = content[at..]
        .char_indices()
        .find(|(_, c)| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-')))
        .map(|(offset, _)| at + offset)
        .unwrap_or(content.len());
    let id = &content[at..end];
    (!id.is_empty()).then(|| (end, id.to_string()))
}

fn has_explicit_id_prefix(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 4 && bytes[..4].eq_ignore_ascii_case(b"bot:")
}

/// Scans every mention token in order, skipping inert spans, `\@`, `@@` and
/// email local parts.
fn scan_tokens(content: &str, index: &MentionIndex<'_>) -> Vec<Token> {
    let inert = inert_ranges(content);
    let chars: Vec<(usize, char)> = content.char_indices().collect();
    let mut tokens = Vec::new();
    let mut position = 0usize;
    while position < chars.len() {
        let (byte, ch) = chars[position];
        if ch != '@' {
            position += 1;
            continue;
        }
        if contains_byte(&inert, byte) {
            position += 1;
            continue;
        }
        // `\@bot` is an escaped literal and `a@corp.example` is an address:
        // neither names anybody.
        let previous = position.checked_sub(1).map(|p| chars[p].1);
        if matches!(previous, Some('\\')) || previous.is_some_and(is_name_char) {
            position += 1;
            continue;
        }
        if chars.get(position + 1).is_some_and(|(_, c)| *c == '@') {
            position += 2;
            continue;
        }
        match parse_token(content, &chars, position, index) {
            Some((token, next)) => {
                tokens.push(token);
                position = next;
            }
            None => position += 1,
        }
    }
    tokens
}

fn parse_token(
    content: &str,
    chars: &[(usize, char)],
    position: usize,
    index: &MentionIndex<'_>,
) -> Option<(Token, usize)> {
    let start = chars[position].0;
    let rest = &content[start + 1..];

    if has_explicit_id_prefix(rest) {
        let id_at = start + 1 + EXPLICIT_ID_PREFIX.len();
        let (end, id) = explicit_id_run(content, id_at)?;
        return Some((
            Token {
                start,
                end,
                source: MentionSource::ExplicitId,
                identity: id,
            },
            byte_to_char_pos(chars, end),
        ));
    }

    if rest.starts_with('[') {
        let label_start = start + 2;
        let label_end = content[label_start..].find(']')?;
        let label = &content[label_start..label_start + label_end];
        let after_bracket = label_start + label_end + 1;
        // A markdown link suffix is the only place an id may ride along with
        // a human label: `@[Growth desk](bot:bot_42)`.
        if content[after_bracket..].starts_with('(')
            && has_explicit_id_prefix(&content[after_bracket + 1..])
        {
            let id_at = after_bracket + 1 + EXPLICIT_ID_PREFIX.len();
            let Some((id_end, id)) = explicit_id_run(content, id_at) else {
                return None;
            };
            if !content[id_end..].starts_with(')') {
                return None;
            }
            return Some((
                Token {
                    start,
                    end: id_end + 1,
                    source: MentionSource::ExplicitId,
                    identity: id,
                },
                byte_to_char_pos(chars, id_end + 1),
            ));
        }
        let identity = normalize(label);
        if identity.is_empty() {
            return None;
        }
        return Some((
            Token {
                start,
                end: after_bracket,
                source: MentionSource::BracketedName,
                identity,
            },
            byte_to_char_pos(chars, after_bracket),
        ));
    }

    let (end, bots) = match index.match_bare(content, start + 1) {
        Some(found) => found,
        None => {
            // No catalog entry claims this token; still report exactly what
            // the user typed so the unresolved case is explainable.
            let (_, run_end) = name_run_at(content, start + 1);
            (run_end, Vec::new())
        }
    };
    if end == start + 1 {
        // `@ ` or `@!` — not a mention at all.
        return None;
    }
    let identity = match bots.first() {
        Some(bot) => normalize(&bot.name),
        None => normalize(&content[start + 1..end]),
    };
    Some((
        Token {
            start,
            end,
            source: MentionSource::BareName,
            identity,
        },
        byte_to_char_pos(chars, end),
    ))
}

fn byte_to_char_pos(chars: &[(usize, char)], byte: usize) -> usize {
    match chars.iter().position(|(at, _)| *at >= byte) {
        Some(found) => found,
        None => chars.len(),
    }
}

fn resolved(member: bool) -> (MentionOutcome, String) {
    (
        MentionOutcome::Resolved,
        if member {
            "resolved".to_string()
        } else {
            "resolvedCrossRoom".to_string()
        },
    )
}

fn resolve_token<'a>(token: &Token, content: &str, index: &MentionIndex<'a>) -> Mention {
    let mut mention = Mention {
        text: content[token.start..token.end].to_string(),
        offset: token.start,
        source: token.source,
        outcome: MentionOutcome::Unresolved,
        reason: "notFound".to_string(),
        bot_id: None,
        member: false,
        candidates: Vec::new(),
    };
    let bots: Vec<&'a BotProfile> = match token.source {
        MentionSource::ExplicitId => {
            let Some(bot) = index.by_id.get(token.identity.as_str()).copied() else {
                // An id that no longer exists is never resolved by name text:
                // that would silently hand the turn to a different agent.
                mention.reason = "unknownBotId".to_string();
                return mention;
            };
            mention.candidates = index.candidates(std::slice::from_ref(&bot));
            let (outcome, reason) = resolved(index.is_member(bot));
            mention.outcome = outcome;
            mention.reason = reason;
            mention.bot_id = Some(bot.id.clone());
            mention.member = index.is_member(bot);
            return mention;
        }
        MentionSource::BracketedName => index
            .by_name
            .get(token.identity.as_str())
            .cloned()
            .unwrap_or_default(),
        MentionSource::BareName => index
            .match_bare(content, token.start + 1)
            .map(|(_, bots)| bots)
            .unwrap_or_default(),
    };

    mention.candidates = index.candidates(&bots);
    let distinct: HashSet<&str> = bots.iter().map(|bot| bot.id.as_str()).collect();
    match distinct.len() {
        0 => mention.reason = "notFound".to_string(),
        1 => {
            let bot = bots[0];
            mention.member = index.is_member(bot);
            let (outcome, reason) = resolved(mention.member);
            mention.outcome = outcome;
            mention.reason = reason;
            mention.bot_id = Some(bot.id.clone());
        }
        _ => {
            // Two distinct agents answer to this text. Picking one would be a
            // guess, so the plan reports candidates and dispatches nothing.
            mention.outcome = MentionOutcome::Ambiguous;
            mention.reason = "duplicateName".to_string();
        }
    }
    mention
}

/// Resolve one message. `max_members` and `max_external` are the dispatch
/// budgets of the admission layer: mentions past them stay `resolved` and
/// explainable, but are left out of the plan's dispatch lists and the plan is
/// flagged `truncated`.
pub(crate) fn resolve_mentions<'a>(
    content: &str,
    members: &'a [RoomMember],
    bots: &'a [BotProfile],
    max_members: usize,
    max_external: usize,
) -> MentionPlan {
    let index = MentionIndex::new(members, bots);
    let mut mentions: Vec<Mention> = scan_tokens(content, &index)
        .iter()
        .map(|token| resolve_token(token, content, &index))
        .collect();

    let mut plan = MentionPlan::default();
    let mut member_ids: Vec<String> = Vec::new();
    let mut external_ids: Vec<String> = Vec::new();
    for mention in &mut mentions {
        if mention.outcome != MentionOutcome::Resolved {
            continue;
        }
        let Some(bot_id) = mention.bot_id.clone() else {
            continue;
        };
        let (list, cap) = if mention.member {
            (&mut member_ids, max_members)
        } else {
            (&mut external_ids, max_external)
        };
        if list.contains(&bot_id) {
            continue; // the agent already gets this message once
        }
        if list.len() >= cap {
            mention.reason = "overMentionCap".to_string();
            plan.truncated = true;
            continue;
        }
        list.push(bot_id);
    }
    plan.resolved_member_bot_ids = member_ids;
    plan.resolved_external_bot_ids = external_ids;
    plan.ambiguous = mentions
        .iter()
        .filter(|mention| mention.outcome == MentionOutcome::Ambiguous)
        .cloned()
        .collect();
    plan.unresolved = mentions
        .iter()
        .filter(|mention| mention.outcome == MentionOutcome::Unresolved)
        .cloned()
        .collect();
    plan.mentions = mentions;
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(id: &str, name: &str) -> BotProfile {
        BotProfile {
            id: id.to_string(),
            name: name.to_string(),
            soul: "soul".to_string(),
            soul_revision: 1,
            soul_history: Vec::new(),
            backend_kind: "kernel".to_string(),
            backend_binding_id: None,
            is_default: false,
            created_at: "2026-09-12T00:00:00Z".to_string(),
            updated_at: "2026-09-12T00:00:00Z".to_string(),
            revision: 1,
        }
    }

    fn member(bot_id: &str) -> RoomMember {
        RoomMember {
            bot_id: bot_id.to_string(),
            role: "member".to_string(),
            added_at: "2026-09-12T00:00:00Z".to_string(),
        }
    }

    fn plan_for(content: &str, members: &[RoomMember], bots: &[BotProfile]) -> MentionPlan {
        resolve_mentions(content, members, bots, 3, 2)
    }

    #[test]
    fn prefix_names_resolve_to_the_whole_token_only() {
        let bots = vec![bot("bot_ann", "Ann"), bot("bot_anna", "Anna")];
        let members = vec![member("bot_ann"), member("bot_anna")];

        let short = plan_for("@Ann hi", &members, &bots);
        assert_eq!(short.resolved_member_bot_ids, vec!["bot_ann".to_string()]);
        assert_eq!(short.mentions[0].text, "@Ann");

        let long = plan_for("@Anna hi", &members, &bots);
        assert_eq!(long.resolved_member_bot_ids, vec!["bot_anna".to_string()]);
        assert_eq!(long.mentions[0].text, "@Anna");

        // A prefix of an existing name is not an abbreviation of it.
        let miss = plan_for("@Annabel hi", &members, &bots);
        assert!(miss.resolved_member_bot_ids.is_empty());
        assert_eq!(miss.unresolved[0].reason, "notFound");
        assert_eq!(miss.unresolved[0].text, "@Annabel");
    }

    #[test]
    fn duplicate_names_are_ambiguous_and_dispatch_nothing() {
        let bots = vec![bot("bot_a", "Ops"), bot("bot_b", "Ops")];
        let members = vec![member("bot_a"), member("bot_b")];
        let resolved = plan_for("hey @Ops look", &members, &bots);
        assert!(resolved.resolved_member_bot_ids.is_empty());
        assert!(resolved.resolved_external_bot_ids.is_empty());
        assert_eq!(resolved.ambiguous.len(), 1);
        assert_eq!(resolved.ambiguous[0].reason, "duplicateName");
        let mut ids: Vec<&str> = resolved.ambiguous[0]
            .candidates
            .iter()
            .map(|candidate| candidate.bot_id.as_str())
            .collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["bot_a", "bot_b"]);
    }

    #[test]
    fn member_and_non_member_collision_stays_ambiguous() {
        let bots = vec![bot("bot_in", "Nina"), bot("bot_out", "Nina")];
        let members = vec![member("bot_in")];
        let resolved = plan_for("@Nina", &members, &bots);
        assert!(resolved.resolved_member_bot_ids.is_empty());
        assert!(resolved.resolved_external_bot_ids.is_empty());
        assert_eq!(resolved.ambiguous.len(), 1);
    }

    #[test]
    fn explicit_id_wins_and_survives_a_rename() {
        let mut bots = vec![bot("bot_anna", "Anna"), bot("bot_ann", "Ann")];
        let members = vec![member("bot_anna"), member("bot_ann")];
        let first = plan_for("@[Anna](bot:bot_anna) and @Ann", &members, &bots);
        assert_eq!(
            first.resolved_member_bot_ids,
            vec!["bot_anna".to_string(), "bot_ann".to_string()]
        );
        assert_eq!(first.mentions[0].source, MentionSource::ExplicitId);

        // The label is decorative: renaming the bot cannot move an id mention.
        bots[0].name = "Something else".to_string();
        let after = plan_for("@[Anna](bot:bot_anna)", &members, &bots);
        assert_eq!(after.resolved_member_bot_ids, vec!["bot_anna".to_string()]);
        assert_eq!(after.mentions[0].outcome, MentionOutcome::Resolved);

        let bare = plan_for("@Anna", &members, &bots);
        assert_eq!(bare.unresolved[0].reason, "notFound");
    }

    #[test]
    fn explicit_id_targets_exactly_one_agent_among_duplicates() {
        let bots = vec![bot("bot_a", "Ops"), bot("bot_b", "Ops")];
        let members = vec![member("bot_a"), member("bot_b")];
        let resolved = plan_for("@bot:bot_b go", &members, &bots);
        assert_eq!(resolved.resolved_member_bot_ids, vec!["bot_b".to_string()]);
        assert!(resolved.ambiguous.is_empty());
        assert_eq!(resolved.mentions[0].text, "@bot:bot_b");
    }

    #[test]
    fn unknown_explicit_id_never_falls_back_to_a_name() {
        let bots = vec![bot("bot_a", "Ops")];
        let members = vec![member("bot_a")];
        let resolved = plan_for("@bot:bot_ghost Ops", &members, &bots);
        assert!(resolved.resolved_member_bot_ids.is_empty());
        assert_eq!(resolved.unresolved[0].reason, "unknownBotId");
    }

    #[test]
    fn names_with_spaces_and_cjk_need_a_boundary_not_a_substring() {
        let bots = vec![
            bot("bot_cli", "CLI teammate"),
            bot("bot_lab", "研究 助手"),
            bot("bot_sol", "研究助手"),
        ];
        let members = vec![member("bot_cli"), member("bot_lab"), member("bot_sol")];

        let cli = plan_for("@CLI teammate do work", &members, &bots);
        assert_eq!(cli.resolved_member_bot_ids, vec!["bot_cli".to_string()]);
        assert_eq!(cli.mentions[0].text, "@CLI teammate");

        let spaced = plan_for("@研究 助手 now", &members, &bots);
        assert_eq!(spaced.resolved_member_bot_ids, vec!["bot_lab".to_string()]);
        let solid = plan_for("@研究助手 now", &members, &bots);
        assert_eq!(solid.resolved_member_bot_ids, vec!["bot_sol".to_string()]);

        let bracketed = plan_for("@[研究 助手] now", &members, &bots);
        assert_eq!(
            bracketed.resolved_member_bot_ids,
            vec!["bot_lab".to_string()]
        );
        assert_eq!(bracketed.mentions[0].source, MentionSource::BracketedName);

        // A bracketed label must exist in the catalog, and a name with a
        // space cannot be summoned by a substring of it.
        let ghost = plan_for("@[nobody here]", &members, &bots);
        assert_eq!(ghost.unresolved[0].reason, "notFound");
        let partial = plan_for("@研究 now", &members, &bots);
        assert!(partial.resolved_member_bot_ids.is_empty());
    }

    #[test]
    fn longest_name_wins_when_one_name_extends_another() {
        let bots = vec![bot("bot_sis", "研究"), bot("bot_lab", "研究 助手")];
        let members = vec![member("bot_sis"), member("bot_lab")];
        let long = plan_for("@研究 助手 go", &members, &bots);
        assert_eq!(long.resolved_member_bot_ids, vec!["bot_lab".to_string()]);
        let short = plan_for("@研究 go", &members, &bots);
        assert_eq!(short.resolved_member_bot_ids, vec!["bot_sis".to_string()]);
    }

    #[test]
    fn emails_escapes_and_code_never_fire() {
        let bots = vec![bot("bot_alice", "Alice")];
        let members = vec![member("bot_alice")];

        for text in [
            "mail ops@alice.dev for the log",
            "not a hook: \\@Alice",
            "double at @@Alice",
            "call `@Alice` from the doc",
            "```\n@Alice\n```",
            "~~~\nsee @Alice\n~~~",
            "truncated fence\n```\n@Alice",
            "block ends `@Alice` inline",
            "> @Alice please inspect this quoted example",
            "  > @Alice nested-looking quoted example",
        ] {
            let quiet = plan_for(text, &members, &bots);
            assert!(
                quiet.resolved_member_bot_ids.is_empty(),
                "unexpected dispatch from {text:?}: {quiet:?}"
            );
        }

        let fired = plan_for("@Alice go", &members, &bots);
        assert_eq!(fired.resolved_member_bot_ids, vec!["bot_alice".to_string()]);
        // An address that merely ends where a mention begins still counts.
        let mixed = plan_for("ops@corp.example then @Alice now", &members, &bots);
        assert_eq!(mixed.resolved_member_bot_ids, vec!["bot_alice".to_string()]);
        assert_eq!(mixed.mentions.len(), 1);

        let quoted_then_live = plan_for(
            "> @Alice old instruction\n@Alice new instruction",
            &members,
            &bots,
        );
        assert_eq!(
            quoted_then_live.resolved_member_bot_ids,
            vec!["bot_alice".to_string()]
        );
        assert_eq!(quoted_then_live.mentions.len(), 1);
    }

    #[test]
    fn punctuation_boundaries_and_repeats_are_deduplicated() {
        let bots = vec![bot("bot_alice", "Alice"), bot("bot_bob", "Bob")];
        let members = vec![member("bot_alice"), member("bot_bob")];
        let resolved = plan_for("@Alice, @Alice! and @Bob?", &members, &bots);
        assert_eq!(
            resolved.resolved_member_bot_ids,
            vec!["bot_alice".to_string(), "bot_bob".to_string()]
        );
        assert_eq!(resolved.mentions.len(), 3);

        // Sentence punctuation is not part of the token, so a closing dot
        // cannot turn `@Alice` into an unknown handle.
        let dotted = plan_for("cc @Alice.", &members, &bots);
        assert_eq!(
            dotted.resolved_member_bot_ids,
            vec!["bot_alice".to_string()]
        );
        assert_eq!(dotted.mentions[0].text, "@Alice");
    }

    #[test]
    fn dispatch_budget_is_visible_but_explainable() {
        let bots: Vec<BotProfile> = (0..5)
            .map(|i| bot(&format!("bot_{i}"), &format!("B{i}")))
            .collect();
        let members: Vec<RoomMember> = (0..5).map(|i| member(&format!("bot_{i}"))).collect();
        let resolved = plan_for("@B0 @B1 @B2 @B3 @B4", &members, &bots);
        assert_eq!(resolved.resolved_member_bot_ids.len(), 3);
        assert!(resolved.truncated);
        let capped: Vec<&str> = resolved
            .mentions
            .iter()
            .filter(|mention| mention.reason == "overMentionCap")
            .map(|mention| mention.text.as_str())
            .collect();
        assert_eq!(capped, vec!["@B3", "@B4"]);
        assert!(
            resolved
                .mentions
                .iter()
                .all(|mention| mention.outcome == MentionOutcome::Resolved)
        );
    }

    #[test]
    fn cross_room_targets_are_a_separate_class() {
        let bots = vec![bot("bot_in", "Alice"), bot("bot_out", "Outsider")];
        let members = vec![member("bot_in")];
        let resolved = plan_for("@Alice @Outsider", &members, &bots);
        assert_eq!(resolved.resolved_member_bot_ids, vec!["bot_in".to_string()]);
        assert_eq!(
            resolved.resolved_external_bot_ids,
            vec!["bot_out".to_string()]
        );
        assert_eq!(resolved.mentions[1].reason, "resolvedCrossRoom");
        assert!(!resolved.mentions[1].member);
    }

    #[test]
    fn an_empty_message_is_an_empty_plan() {
        let bots = vec![bot("bot_a", "A")];
        let members = vec![member("bot_a")];
        let resolved = plan_for("no routing words at all", &members, &bots);
        assert!(resolved.is_empty());
        assert!(resolved.mentions.is_empty());
        assert!(!resolved.truncated);
    }

    #[test]
    fn plan_is_stable_json_for_fixture_comparison() {
        let bots = vec![bot("bot_a", "Ann"), bot("bot_b", "Anna")];
        let members = vec![member("bot_a"), member("bot_b")];
        let value = serde_json::to_value(plan_for("@ann and @Anna!", &members, &bots)).unwrap();
        assert_eq!(value["mentions"][0]["offset"], 0);
        assert_eq!(value["mentions"][0]["outcome"], "resolved");
        assert_eq!(value["mentions"][0]["botId"], "bot_a");
        assert_eq!(value["mentions"][1]["outcome"], "resolved");
        assert_eq!(value["mentions"][1]["botId"], "bot_b");
        assert_eq!(value["truncated"], false);
    }
}
