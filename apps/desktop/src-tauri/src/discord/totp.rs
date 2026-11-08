//! The six-digit approval code the owner types in Discord to approve a merge or a release (#207).
//!
//! RFC 6238 with SHA-1, 30-second steps and six digits: what every authenticator app shows by
//! default. A code is good for the step before, the step of and the step after the moment it is
//! read, and each step approves once. Three wrong codes lock approvals until the owner unlocks
//! them at the Mac; a locked record refuses without looking at the code.

use ring::hmac;
use serde::{Deserialize, Serialize};

pub(crate) const STEP_SECS: u64 = 30;
pub(crate) const LOCK_AFTER: u32 = 3;
/// 160 bits, the key size RFC 4226 recommends for SHA-1.
pub(crate) const SECRET_BYTES: usize = 20;

/// What the Keychain keeps. `secret` is hex; `last_step` is the step of the last code that
/// approved, so a code (or an earlier one) cannot approve again, across launches too.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    pub(crate) secret: String,
    pub(crate) last_step: u64,
    pub(crate) failures: u32,
    pub(crate) locked: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Approved,
    /// Right code for a step that already approved. Not counted: it cannot approve anything.
    Reused,
    /// `locked` says whether this wrong code was the one that locked approvals.
    Wrong { locked: bool },
    /// Refused unchecked; nothing counted.
    Locked,
    /// Not six ASCII digits, or a secret that does not decode. Refused unchecked.
    Malformed,
}

impl Record {
    pub(crate) fn new(secret_hex: String) -> Self {
        Self { secret: secret_hex, last_step: 0, failures: 0, locked: false }
    }

    /// Checks `code` at `now_secs` (Unix time) and updates the record. The caller must write the
    /// record back to the Keychain before acting on `Approved`, or a restart could approve twice.
    pub(crate) fn check(&mut self, code: &str, now_secs: u64) -> Verdict {
        if self.locked {
            return Verdict::Locked;
        }
        let Some(typed) = parse_code(code) else { return Verdict::Malformed };
        let Some(secret) = from_hex(&self.secret) else { return Verdict::Malformed };
        let now = now_secs / STEP_SECS;
        let mut fresh = None;
        let mut used = false;
        for step in [now + 1, now, now.saturating_sub(1)] {
            if code_at(&secret, step) == typed {
                if step > self.last_step {
                    fresh = fresh.or(Some(step));
                } else {
                    used = true;
                }
            }
        }
        match fresh {
            Some(step) => {
                self.last_step = step;
                self.failures = 0;
                Verdict::Approved
            }
            None if used => Verdict::Reused,
            None => {
                self.failures += 1;
                self.locked = self.failures >= LOCK_AFTER;
                Verdict::Wrong { locked: self.locked }
            }
        }
    }

    pub(crate) fn unlock(&mut self) {
        self.failures = 0;
        self.locked = false;
    }
}

pub(crate) fn code_at(secret: &[u8], step: u64) -> u32 {
    let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret);
    let tag = hmac::sign(&key, &step.to_be_bytes());
    let digest = tag.as_ref();
    let offset = usize::from(digest[digest.len() - 1] & 0x0f);
    let bin = u32::from_be_bytes([
        digest[offset] & 0x7f,
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]);
    bin % 1_000_000
}

fn parse_code(code: &str) -> Option<u32> {
    (code.len() == 6 && code.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| code.parse().ok())
        .flatten()
}

pub(crate) fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(text.get(index..index + 2)?, 16).ok())
        .collect()
}

/// RFC 4648 base32 without padding: the form authenticator apps take a secret in.
pub(crate) fn base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let (mut buffer, mut bits) = (0_u32, 0_u32);
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(ALPHABET[((buffer >> bits) & 31) as usize]));
        }
    }
    if bits > 0 {
        out.push(char::from(ALPHABET[((buffer << (5 - bits)) & 31) as usize]));
    }
    out
}

pub(crate) fn otpauth_uri(secret: &[u8]) -> String {
    format!(
        "otpauth://totp/Gyredeck:approvals?secret={}&issuer=Gyredeck&algorithm=SHA1&digits=6&period={STEP_SECS}",
        base32(secret)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC_SECRET: &[u8] = b"12345678901234567890";

    fn record() -> Record {
        Record::new(RFC_SECRET.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    fn code(now_secs: u64) -> String {
        format!("{:06}", code_at(RFC_SECRET, now_secs / STEP_SECS))
    }

    // RFC 6238 appendix B, SHA-1 column, last six digits.
    #[test]
    fn c1_codes_match_the_rfc_6238_vectors() {
        for (time, expected) in [
            (59_u64, 287_082),
            (1_111_111_109, 81_804),
            (1_111_111_111, 50_471),
            (1_234_567_890, 5_924),
            (2_000_000_000, 279_037),
            (20_000_000_000, 353_130),
        ] {
            assert_eq!(code_at(RFC_SECRET, time / STEP_SECS), expected, "at {time}");
        }
    }

    #[test]
    fn c2_a_code_holds_for_one_step_either_side_and_no_further() {
        let now = 1_700_000_000_u64;
        for offset in [-30_i64, 0, 30] {
            let typed = code(now.checked_add_signed(offset).unwrap());
            assert_eq!(record().check(&typed, now), Verdict::Approved, "offset {offset}");
        }
        for offset in [-60_i64, 60] {
            let typed = code(now.checked_add_signed(offset).unwrap());
            assert_eq!(
                record().check(&typed, now),
                Verdict::Wrong { locked: false },
                "offset {offset}"
            );
        }
    }

    #[test]
    fn c3_a_step_approves_once_and_the_used_step_survives_a_restart() {
        let now = 1_700_000_000;
        let mut first = record();
        assert_eq!(first.check(&code(now), now), Verdict::Approved);
        assert_eq!(first.check(&code(now), now), Verdict::Reused);
        let saved = serde_json::to_string(&first).unwrap();
        let mut relaunched: Record = serde_json::from_str(&saved).unwrap();
        assert_eq!(relaunched.check(&code(now), now + 10), Verdict::Reused);
        assert_eq!(relaunched.check(&code(now - 30), now), Verdict::Reused);
        assert_eq!(relaunched.failures, 0);
        assert_eq!(relaunched.check(&code(now + 30), now + 30), Verdict::Approved);
    }

    #[test]
    fn a_clock_set_back_cannot_approve_an_earlier_step_again() {
        let now = 1_700_000_000;
        let mut held = record();
        assert_eq!(held.check(&code(now), now), Verdict::Approved);
        for back in [300, 3_600, 86_400] {
            assert_eq!(held.check(&code(now - back), now - back), Verdict::Reused, "{back} s back");
        }
        assert_eq!(held.failures, 0);
    }

    #[test]
    fn c4_three_wrong_codes_lock_and_a_locked_record_refuses_the_right_one() {
        let now = 1_700_000_000;
        let wrong = format!("{:06}", (code_at(RFC_SECRET, now / STEP_SECS) + 1) % 1_000_000);
        let mut locking = record();
        assert_eq!(locking.check(&wrong, now), Verdict::Wrong { locked: false });
        assert_eq!(locking.check(&wrong, now), Verdict::Wrong { locked: false });
        assert_eq!(locking.check(&wrong, now), Verdict::Wrong { locked: true });
        assert_eq!(locking.check(&code(now), now), Verdict::Locked);
        assert_eq!(locking.failures, LOCK_AFTER);
        locking.unlock();
        assert_eq!(locking.check(&code(now), now), Verdict::Approved);
    }

    #[test]
    fn a_right_code_clears_the_count_of_wrong_ones() {
        let now = 1_700_000_000;
        let wrong = format!("{:06}", (code_at(RFC_SECRET, now / STEP_SECS) + 1) % 1_000_000);
        let mut held = record();
        held.check(&wrong, now);
        held.check(&wrong, now);
        assert_eq!(held.check(&code(now), now), Verdict::Approved);
        assert_eq!(held.check(&wrong, now + 30), Verdict::Wrong { locked: false });
    }

    #[test]
    fn anything_but_six_digits_is_refused_unchecked() {
        let mut held = record();
        for typed in ["", "12345", "1234567", "12345a", " 123456", "１２３４５６", "+12345"] {
            assert_eq!(held.check(typed, 1_700_000_000), Verdict::Malformed, "{typed:?}");
        }
        assert_eq!(held.failures, 0);
    }

    #[test]
    fn base32_matches_rfc_4648() {
        for (input, expected) in [
            ("", ""),
            ("f", "MY"),
            ("fo", "MZXQ"),
            ("foo", "MZXW6"),
            ("foob", "MZXW6YQ"),
            ("fooba", "MZXW6YTB"),
            ("foobar", "MZXW6YTBOI"),
        ] {
            assert_eq!(base32(input.as_bytes()), expected);
        }
        assert_eq!(base32(RFC_SECRET), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    }

    #[test]
    fn hex_round_trips_and_refuses_junk() {
        assert_eq!(from_hex("00ff7a"), Some(vec![0, 255, 0x7a]));
        assert_eq!(from_hex("0"), None);
        assert_eq!(from_hex("zz"), None);
    }
}
