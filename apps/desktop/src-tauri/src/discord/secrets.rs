//! Where the Discord token and owner live in the Keychain (#288).
//!
//! A signed build keeps them in the data-protection keychain, in the app's own access group:
//! macOS lets only apps signed by this team and carrying that group reach them, and any build
//! of the app can read, replace and delete what an earlier one wrote. An item an ad-hoc build
//! left in the file keychain is moved over once, then a marker says the move is done, so a
//! Remove never brings the old item back. A build without the entitlement (an ad-hoc local
//! build) keeps using the file keychain, as before.

/// errSecItemNotFound: the only answer that means "nothing is saved".
pub(crate) const NOT_FOUND: i32 = -25300;
/// errSecMissingEntitlement: this build has no access group, so it is an ad-hoc one.
pub(crate) const MISSING_ENTITLEMENT: i32 = -34018;
/// errSecInteractionNotAllowed: the Mac is locked and the item is not readable until it opens.
pub(crate) const LOCKED: i32 = -25308;

/// One stored value, as one keychain sees it. `Ok(None)` is errSecItemNotFound and nothing else.
pub(crate) trait Slot {
    fn read(&self) -> Result<Option<Vec<u8>>, i32>;
    fn write(&self, value: &[u8]) -> Result<(), i32>;
    /// Gone already counts as deleted.
    fn delete(&self) -> Result<(), i32>;
}

/// What a read found. `Refused` is never "not set up": the value may be there, unreadable.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Read {
    Found(Vec<u8>),
    Absent,
    Refused(String),
    /// Refused only because the Mac is locked (#325): the value is there, and readable once it opens.
    Locked(String),
}

fn refused(code: i32) -> Read {
    if code == LOCKED { Read::Locked(describe(code)) } else { Read::Refused(describe(code)) }
}

pub(crate) fn describe(code: i32) -> String {
    let why = match code {
        -128 => "the request was cancelled",
        -25293 => "macOS did not allow it",
        -25308 => "macOS needed to ask and could not",
        MISSING_ENTITLEMENT => "this build is not allowed into the app's keychain group",
        _ => "macOS refused",
    };
    format!("{why} (OSStatus {code})")
}

/// The team's item first. Absent there, and not moved before, the file-keychain item is moved
/// over: written to the team's group, marked moved, then deleted from the file keychain if
/// macOS lets this build. One that cannot be read is reported, and nothing is marked or
/// deleted, so the next read tries again.
pub(crate) fn read(team: &dyn Slot, moved: &dyn Slot, file: &dyn Slot) -> Read {
    match team.read() {
        Ok(Some(value)) => Read::Found(value),
        Err(MISSING_ENTITLEMENT) => match file.read() {
            Ok(Some(value)) => Read::Found(value),
            Ok(None) => Read::Absent,
            Err(code) => refused(code),
        },
        Err(code) => refused(code),
        Ok(None) => match moved.read() {
            Ok(Some(_)) => Read::Absent,
            Err(code) => refused(code),
            Ok(None) => match file.read() {
                Err(code) => refused(code),
                Ok(old) => {
                    if let Some(value) = old.as_deref() {
                        if let Err(code) = team.write(value) {
                            return refused(code);
                        }
                    }
                    if moved.write(b"1").is_ok() {
                        let _ = file.delete();
                    }
                    old.map_or(Read::Absent, Read::Found)
                }
            },
        },
    }
}

/// Into the team's item, created or updated in place: no delete first, so no moment without
/// one, and nothing an earlier build wrote is in the way. Marked moved, so an old file-keychain
/// item is never taken over it later.
pub(crate) fn write(team: &dyn Slot, moved: &dyn Slot, file: &dyn Slot, value: &[u8]) -> Result<(), String> {
    match team.write(value) {
        Ok(()) => {
            let _ = moved.write(b"1");
            let _ = file.delete();
            Ok(())
        }
        Err(MISSING_ENTITLEMENT) => file.write(value).map_err(describe),
        Err(code) => Err(describe(code)),
    }
}

/// Gone from where this build reads it, and for good: the moved marker is saved before the
/// team's item goes, so an old file-keychain item macOS will not let this build delete can never
/// be moved back in as the value. A marker that cannot be saved refuses the Remove and leaves
/// the value as it was (#288 audit).
pub(crate) fn delete(team: &dyn Slot, moved: &dyn Slot, file: &dyn Slot) -> Result<(), String> {
    match moved.write(b"1") {
        Ok(()) => {}
        Err(MISSING_ENTITLEMENT) => return file.delete().map_err(describe),
        Err(code) => return Err(describe(code)),
    }
    team.delete().map_err(describe)?;
    let _ = file.delete();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        value: RefCell<Option<Vec<u8>>>,
        read_err: Option<i32>,
        write_err: Option<i32>,
        delete_err: Option<i32>,
        writes: RefCell<u32>,
        deletes: RefCell<u32>,
    }
    impl Fake {
        fn holding(value: &[u8]) -> Self {
            Fake { value: RefCell::new(Some(value.to_vec())), ..Fake::default() }
        }
        fn unentitled() -> Self {
            Fake { read_err: Some(MISSING_ENTITLEMENT), write_err: Some(MISSING_ENTITLEMENT), delete_err: Some(MISSING_ENTITLEMENT), ..Fake::default() }
        }
        fn now(&self) -> Option<Vec<u8>> {
            self.value.borrow().clone()
        }
    }
    impl Slot for Fake {
        fn read(&self) -> Result<Option<Vec<u8>>, i32> {
            self.read_err.map_or_else(|| Ok(self.now()), Err)
        }
        fn write(&self, value: &[u8]) -> Result<(), i32> {
            *self.writes.borrow_mut() += 1;
            if let Some(code) = self.write_err {
                return Err(code);
            }
            *self.value.borrow_mut() = Some(value.to_vec());
            Ok(())
        }
        fn delete(&self) -> Result<(), i32> {
            *self.deletes.borrow_mut() += 1;
            if let Some(code) = self.delete_err {
                return Err(code);
            }
            *self.value.borrow_mut() = None;
            Ok(())
        }
    }

    #[test]
    fn the_first_signed_read_moves_the_ad_hoc_item_over_once_and_marks_it() {
        let (team, moved, file) = (Fake::default(), Fake::default(), Fake::holding(b"old"));
        assert_eq!(read(&team, &moved, &file), Read::Found(b"old".to_vec()));
        assert_eq!(team.now(), Some(b"old".to_vec()));
        assert!(moved.now().is_some());
        assert_eq!(file.now(), None, "deleted from the file keychain when macOS allows it");
    }

    #[test]
    fn an_old_item_this_build_cannot_delete_never_comes_back_after_a_remove() {
        let (team, moved, file) = (Fake::default(), Fake::default(), Fake { delete_err: Some(-25293), ..Fake::holding(b"old") });
        assert_eq!(read(&team, &moved, &file), Read::Found(b"old".to_vec()));
        assert_eq!(delete(&team, &moved, &file), Ok(()));
        assert_eq!(read(&team, &moved, &file), Read::Absent, "moved once; the old item is not taken again");
    }

    #[test]
    fn an_old_item_macos_refuses_to_show_is_reported_and_nothing_is_marked_or_deleted() {
        let (team, moved, file) = (Fake::default(), Fake::default(), Fake { read_err: Some(-25293), ..Fake::holding(b"old") });
        assert!(matches!(read(&team, &moved, &file), Read::Refused(why) if why.contains("-25293")));
        assert_eq!((moved.now(), *file.deletes.borrow()), (None, 0), "tried again next time");
        assert_eq!(file.now(), Some(b"old".to_vec()));
    }

    #[test]
    fn a_refused_read_of_the_teams_item_is_never_absent() {
        let (team, moved, file) = (Fake { read_err: Some(-25308), ..Fake::default() }, Fake::default(), Fake::holding(b"old"));
        // The lock is said as the lock (#325), and is no more "absent" than any other refusal.
        assert!(matches!(read(&team, &moved, &file), Read::Locked(why) if why.contains("-25308")));
        assert_eq!(team.now(), None);
        assert_eq!(*team.writes.borrow(), 0, "nothing is moved over a value that may be there");
    }

    #[test]
    fn a_write_replaces_in_place_with_no_delete_first() {
        let (team, moved, file) = (Fake::holding(b"one"), Fake::default(), Fake::default());
        assert_eq!(write(&team, &moved, &file, b"two"), Ok(()));
        assert_eq!((team.now(), *team.deletes.borrow()), (Some(b"two".to_vec()), 0));
        assert!(moved.now().is_some(), "a value written here is never overtaken by an old one");
    }

    #[test]
    fn a_failed_write_says_why_and_leaves_the_old_value() {
        let (team, moved, file) = (Fake { write_err: Some(-25293), ..Fake::holding(b"one") }, Fake::default(), Fake::default());
        assert!(write(&team, &moved, &file, b"two").unwrap_err().contains("-25293"));
        assert_eq!(team.now(), Some(b"one".to_vec()));
    }

    #[test]
    fn a_refused_delete_is_reported_not_claimed() {
        let (team, moved, file) = (Fake { delete_err: Some(-25293), ..Fake::holding(b"one") }, Fake::default(), Fake::default());
        assert!(delete(&team, &moved, &file).is_err());
        assert_eq!(team.now(), Some(b"one".to_vec()));
    }

    // Codex's #288 finding: a Remove reported done while an old item could still come back.
    #[test]
    fn a_remove_whose_marker_cannot_be_saved_is_refused_and_leaves_the_value() {
        let refused = || Fake { write_err: Some(-25293), ..Fake::default() };
        let (team, moved, file) = (Fake::default(), refused(), Fake { delete_err: Some(-25293), ..Fake::holding(b"old") });
        assert_eq!(read(&team, &moved, &file), Read::Found(b"old".to_vec()), "premise: moved over, marker refused");
        assert!(delete(&team, &moved, &file).is_err(), "not reported gone while the old item could come back");
        assert_eq!(read(&team, &moved, &file), Read::Found(b"old".to_vec()), "the value is as it was");
        assert_eq!(team.now(), Some(b"old".to_vec()));
    }

    #[test]
    fn a_new_value_then_a_remove_with_the_marker_refused_is_refused_too() {
        let (team, moved, file) = (Fake::default(), Fake { write_err: Some(-25293), ..Fake::default() }, Fake { delete_err: Some(-25293), ..Fake::holding(b"old") });
        assert_eq!(write(&team, &moved, &file, b"new"), Ok(()), "premise: the new value is saved, its marker is not");
        assert!(delete(&team, &moved, &file).is_err());
        assert_eq!(read(&team, &moved, &file), Read::Found(b"new".to_vec()), "never the old item in its place");
    }

    #[test]
    fn an_ad_hoc_build_keeps_using_the_file_keychain() {
        // The marker lives in the team's group too, which an ad-hoc build cannot reach.
        let (team, moved, file) = (Fake::unentitled(), Fake::unentitled(), Fake::default());
        assert_eq!(write(&team, &moved, &file, b"v"), Ok(()));
        assert_eq!(read(&team, &moved, &file), Read::Found(b"v".to_vec()));
        assert_eq!(delete(&team, &moved, &file), Ok(()));
        assert_eq!(read(&team, &moved, &file), Read::Absent);
        assert_eq!(moved.now(), None);
    }
}
