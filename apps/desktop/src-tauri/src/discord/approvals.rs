//! What one approval code approves (#207), and how long a request for one stays answerable.
//!
//! An assistant asks the owner with an `approval` naming one act: merge PR N at a commit, or
//! release a version at a commit. The bridge checks the shape before it publishes; this side
//! checks it again before handing it to the child, and keeps what it handed per room and seq,
//! so a code is only checked against a request this side relayed itself.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// How long a relayed request takes a code.
pub(crate) const REQUEST_LIVES: Duration = Duration::from_secs(30 * 60);
/// How many requests one room keeps open for a code. Past it a new one is relayed as one that
/// cannot be approved from Discord.
pub(crate) const REQUESTS_MAX: usize = 64;
/// How many it remembers at all, open or not, so a Reply to any of them holding a code is refused.
pub(crate) const KEPT_MAX: usize = 4 * REQUESTS_MAX;
/// A code typed longer ago than this, by Discord's own clock, is not checked.
pub(crate) const CODE_FRESH_MS: u64 = 90_000;
/// Discord's epoch, the zero of a snowflake's timestamp.
const DISCORD_EPOCH_MS: u64 = 1_420_070_400_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Approval {
    Merge { pr: u64, sha: String },
    Release { version: String, sha: String },
}

impl Approval {
    /// Taken only when every field is in the one form the bridge accepts.
    pub(crate) fn parse(value: &serde_json::Value) -> Option<Self> {
        let approval: Self = serde_json::from_value(value.clone()).ok()?;
        approval.valid().then_some(approval)
    }

    /// The request as shown where it cannot take a code: the act, and plainly no ask for one. It
    /// stands in for the asker's own words, which ask for the code.
    pub(crate) fn not_approvable(&self, why: &str) -> String {
        format!("Asked to {}. {why}, so this cannot be approved from Discord. Do not reply with a code.", self.describe())
    }

    fn valid(&self) -> bool {
        match self {
            Self::Merge { pr, sha } => *pr > 0 && valid_sha(sha),
            Self::Release { version, sha } => valid_version(version) && valid_sha(sha),
        }
    }

    /// "merge PR #370 at abc1234def56": what the code approves, said the same way everywhere.
    pub(crate) fn describe(&self) -> String {
        match self {
            Self::Merge { pr, sha } => format!("merge PR #{pr} at {}", &sha[..12]),
            Self::Release { version, sha } => format!("release v{version} at {}", &sha[..12]),
        }
    }
}

fn valid_sha(sha: &str) -> bool {
    sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 5 && part.bytes().all(|byte| byte.is_ascii_digit()) && (part.len() == 1 || !part.starts_with('0'))
        })
}

/// A request this side relayed: what it asks for, who asked, and when it was read.
#[derive(Clone, Debug)]
pub(crate) struct Requested {
    pub(crate) approval: Approval,
    pub(crate) requester: String,
    pub(crate) read_at: Instant,
    /// A code approved it; nothing more is checked against it.
    pub(crate) used: bool,
}

impl Requested {
    pub(crate) fn live(&self, now: Instant) -> bool {
        !self.used && now.saturating_duration_since(self.read_at) < REQUEST_LIVES
    }
}

/// Makes room to remember one more request and says whether it may take a code. The oldest that
/// can no longer be approved go first, and only past [`KEPT_MAX`]: until then a Reply to one holding
/// a code is still refused. With [`REQUESTS_MAX`] still open the new one may not take a code; it is
/// remembered all the same, so a code typed under it is refused and never said to the room.
pub(crate) fn make_room(held: &mut HashMap<u64, Requested>, now: Instant) -> bool {
    while held.len() >= KEPT_MAX {
        let Some(oldest) = held.iter().filter(|(_, requested)| !requested.live(now)).map(|(seq, _)| *seq).min() else {
            break;
        };
        held.remove(&oldest);
    }
    held.values().filter(|requested| requested.live(now)).count() < REQUESTS_MAX
}

/// How long ago, by Discord's clock in the id, the message was sent. `None` for an id that does
/// not hold a time, or one from the future past the same margin.
pub(crate) fn snowflake_age_ms(id: &str, now_ms: u64) -> Option<u64> {
    let sent = (id.parse::<u64>().ok()? >> 22).checked_add(DISCORD_EPOCH_MS)?;
    if sent > now_ms.saturating_add(CODE_FRESH_MS) {
        return None;
    }
    Some(now_ms.saturating_sub(sent))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn only_the_two_acts_in_their_one_form_are_taken() {
        let merge = serde_json::json!({ "action": "merge", "pr": 370, "sha": SHA });
        assert_eq!(Approval::parse(&merge), Some(Approval::Merge { pr: 370, sha: SHA.to_string() }));
        let release = serde_json::json!({ "action": "release", "version": "1.33.0", "sha": SHA });
        assert_eq!(Approval::parse(&release), Some(Approval::Release { version: "1.33.0".to_string(), sha: SHA.to_string() }));
        for bad in [
            serde_json::json!({ "action": "merge", "pr": 0, "sha": SHA }),
            serde_json::json!({ "action": "merge", "pr": 370, "sha": &SHA[..39] }),
            serde_json::json!({ "action": "merge", "pr": 370, "sha": SHA.to_uppercase() }),
            serde_json::json!({ "action": "merge", "pr": "370", "sha": SHA }),
            serde_json::json!({ "action": "merge", "pr": 370, "sha": SHA, "extra": 1 }),
            serde_json::json!({ "action": "release", "version": "v1.33.0", "sha": SHA }),
            serde_json::json!({ "action": "release", "version": "1.33", "sha": SHA }),
            serde_json::json!({ "action": "release", "version": "1.033.0", "sha": SHA }),
            serde_json::json!({ "action": "push", "sha": SHA }),
            serde_json::json!("merge"),
        ] {
            assert_eq!(Approval::parse(&bad), None, "{bad}");
        }
    }

    #[test]
    fn describes_the_act_and_its_commit() {
        assert_eq!(Approval::Merge { pr: 370, sha: SHA.to_string() }.describe(), "merge PR #370 at 0123456789ab");
        assert_eq!(Approval::Release { version: "1.33.0".to_string(), sha: SHA.to_string() }.describe(), "release v1.33.0 at 0123456789ab");
    }

    #[test]
    fn a_snowflake_tells_its_age() {
        // 175928847299117063 is Discord's documented example: 2016-04-30 11:18:25.796 UTC.
        let sent = 1_462_015_105_796_u64;
        assert_eq!(snowflake_age_ms("175928847299117063", sent + 1_000), Some(1_000));
        assert_eq!(snowflake_age_ms("175928847299117063", sent - CODE_FRESH_MS - 1), None);
        assert_eq!(snowflake_age_ms("not-a-number", sent), None);
    }

    #[test]
    fn a_request_lives_thirty_minutes_and_once() {
        let read_at = Instant::now();
        let mut requested = Requested { approval: Approval::Merge { pr: 1, sha: SHA.to_string() }, requester: "a".to_string(), read_at, used: false };
        assert!(requested.live(read_at + REQUEST_LIVES - Duration::from_secs(1)));
        assert!(!requested.live(read_at + REQUEST_LIVES));
        requested.used = true;
        assert!(!requested.live(read_at));
    }

    #[test]
    fn past_the_open_cap_a_request_takes_no_code_and_past_the_kept_cap_the_oldest_dead_goes() {
        let start = Instant::now();
        let now = start + REQUEST_LIVES;
        let request = |used: bool, read_at: Instant| Requested { approval: Approval::Merge { pr: 1, sha: SHA.to_string() }, requester: "a".to_string(), read_at, used };
        let mut held: HashMap<u64, Requested> = (1..=REQUESTS_MAX as u64).map(|seq| (seq, request(false, now))).collect();
        assert!(!make_room(&mut held, now), "all open: the next takes no code");
        assert_eq!(held.len(), REQUESTS_MAX, "and nothing open is let go");
        held.get_mut(&2).unwrap().used = true;
        held.insert(500, request(false, start));
        held.insert(1_000, request(true, now));
        assert!(make_room(&mut held, now), "an open one is used up: the next takes a code");
        assert_eq!(held.len(), REQUESTS_MAX + 2, "dead ones are kept while there is room to remember them");
        for seq in 2_000..2_000 + (KEPT_MAX - held.len()) as u64 {
            held.insert(seq, request(true, now));
        }
        assert_eq!(held.len(), KEPT_MAX);
        make_room(&mut held, now);
        assert_eq!(held.len(), KEPT_MAX - 1);
        assert!(!held.contains_key(&2) && held.contains_key(&1) && held.contains_key(&500), "the oldest dead one goes first, one at a time, and never an open one older than it");
        assert_eq!(held.values().filter(|requested| requested.live(now)).count(), REQUESTS_MAX - 1, "never an open one");
    }
}
