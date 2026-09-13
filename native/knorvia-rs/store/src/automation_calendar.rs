//! Wall-clock calendar occurrences in an explicit IANA time zone (R03).
//! Only stored epoch instants remain the durable fact; this module maps a
//! calendar spec to the next such instant, with defined DST semantics:
//! ambiguous local times (fall-back repeat) take the earlier instant, and
//! missing local times (spring-forward gap) shift forward to the first
//! valid instant on that local date.

use super::{MisfirePolicy, StoreError, invalid};
use chrono::{DateTime, Datelike, Days, TimeDelta, TimeZone, Utc};
use chrono_tz::Tz;

pub(super) struct CalendarSpec<'a> {
    pub timezone: &'a str,
    /// 0 = Sunday .. 6 = Saturday; empty = every day.
    pub weekdays: &'a [u8],
    pub hour: u8,
    pub minute: u8,
    /// 1..=31; empty = every day of the month.
    pub days_of_month: &'a [u8],
    /// Only the month's last day (28..=31 resolved per month).
    pub last_day_of_month: bool,
    /// 1..=12; empty = every month.
    pub months: &'a [u8],
    pub misfire: MisfirePolicy,
}

impl CalendarSpec<'_> {
    pub(super) fn parse_timezone(&self) -> Result<Tz, StoreError> {
        self.timezone.parse::<Tz>().map_err(|_| {
            invalid(format!(
                "calendar timezone {:?} is not an IANA name",
                self.timezone
            ))
        })
    }

    pub(super) fn validate(&self) -> Result<(), StoreError> {
        self.parse_timezone()?;
        if self.hour > 23 {
            return Err(invalid("calendar hour must be 0..=23"));
        }
        if self.minute > 59 {
            return Err(invalid("calendar minute must be 0..=59"));
        }
        if self.weekdays.iter().any(|day| *day > 6) {
            return Err(invalid(
                "calendar weekdays must be 0 (Sunday) ..= 6 (Saturday)",
            ));
        }
        if self.days_of_month.iter().any(|day| !(1..=31).contains(day)) {
            return Err(invalid("calendar daysOfMonth must be 1..=31"));
        }
        if self.months.iter().any(|month| !(1..=12).contains(month)) {
            return Err(invalid("calendar months must be 1..=12"));
        }
        if self.last_day_of_month && !self.days_of_month.is_empty() {
            return Err(invalid(
                "calendar cannot combine lastDayOfMonth with an explicit daysOfMonth list",
            ));
        }
        Ok(())
    }

    fn day_matches(&self, date: chrono::NaiveDate) -> bool {
        if !self.months.is_empty() && !self.months.contains(&(date.month() as u8)) {
            return false;
        }
        if self.last_day_of_month {
            let next_month = if date.month() == 12 {
                chrono::NaiveDate::from_ymd_opt(date.year() + 1, 1, 1)
            } else {
                chrono::NaiveDate::from_ymd_opt(date.year(), date.month() + 1, 1)
            };
            let Some(next_month) = next_month else {
                return false;
            };
            return next_month.pred_opt().is_some_and(|last| last == date);
        }
        if !self.days_of_month.is_empty() && !self.days_of_month.contains(&(date.day() as u8)) {
            return false;
        }
        if !self.weekdays.is_empty()
            && !self
                .weekdays
                .contains(&(date.weekday().num_days_from_sunday() as u8))
        {
            return false;
        }
        true
    }
}

/// The first occurrence strictly after `now_ms`, or None when the calendar
/// admits no occurrence within the searched window (~27 months).
pub(super) fn calendar_next_after(
    spec: &CalendarSpec,
    now_ms: i64,
) -> Result<Option<i64>, StoreError> {
    spec.validate()?;
    let tz = spec.parse_timezone()?;
    let now: DateTime<Utc> = DateTime::from_timestamp_millis(now_ms)
        .ok_or_else(|| invalid("calendar reference time is out of range"))?;
    let mut date = now
        .with_timezone(&tz)
        .date_naive()
        .checked_sub_days(Days::new(1))
        .ok_or_else(|| invalid("calendar reference date is out of range"))?;
    // Start one local day back so a just-missed occurrence (misfire policy
    // evaluation, wake-up lateness) is visible to the caller.
    let local_time =
        chrono::NaiveTime::from_hms_opt(u32::from(spec.hour), u32::from(spec.minute), 0)
            .ok_or_else(|| invalid("calendar time is out of range"))?;
    for _ in 0..800 {
        if spec.day_matches(date)
            && let Some(epoch) = local_instant_ms(&tz, date, local_time)
            && epoch > now_ms
        {
            return Ok(Some(epoch));
        }
        let Some(next) = date.checked_add_days(Days::new(1)) else {
            return Ok(None);
        };
        date = next;
    }
    Ok(None)
}

/// Epoch millis for a local wall-clock time on `date`, with the documented
/// DST semantics: ambiguous takes the earlier instant; a missing (gap) time
/// shifts forward in one-hour steps until it exists.
fn local_instant_ms(tz: &Tz, date: chrono::NaiveDate, time: chrono::NaiveTime) -> Option<i64> {
    let mut naive = chrono::NaiveDateTime::new(date, time);
    for _ in 0..4 {
        match tz.from_local_datetime(&naive) {
            chrono::LocalResult::Single(dt) => {
                return Some(dt.with_timezone(&Utc).timestamp_millis());
            }
            chrono::LocalResult::Ambiguous(earliest, _latest) => {
                return Some(earliest.with_timezone(&Utc).timestamp_millis());
            }
            chrono::LocalResult::None => {
                naive += TimeDelta::try_hours(1).unwrap();
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec<'a>(
        timezone: &'a str,
        weekdays: &'a [u8],
        hour: u8,
        minute: u8,
        days_of_month: &'a [u8],
        last_day_of_month: bool,
        months: &'a [u8],
    ) -> CalendarSpec<'a> {
        CalendarSpec {
            timezone,
            weekdays,
            hour,
            minute,
            days_of_month,
            last_day_of_month,
            months,
            misfire: MisfirePolicy::Skip,
        }
    }

    fn shanghai_ms(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        let tz: Tz = "Asia/Shanghai".parse().unwrap();
        let date = chrono::NaiveDate::from_ymd_opt(year, month, day).unwrap();
        let naive = chrono::NaiveDateTime::new(
            date,
            chrono::NaiveTime::from_hms_opt(hour, minute, 0).unwrap(),
        );
        tz.from_local_datetime(&naive)
            .earliest()
            .map(|dt| dt.with_timezone(&Utc).timestamp_millis())
            .unwrap()
    }

    #[test]
    fn shanghai_workday_nine_am_skips_weekends_and_crosses_years() {
        let weekdays = [1u8, 2, 3, 4, 5]; // Monday..Friday
        // Thursday 2026-12-31 10:00 local: next occurrence is Friday Jan 1
        // 2027 at 09:00 — weekdays only, so the year boundary must resolve.
        let from = shanghai_ms(2026, 12, 31, 10, 0);
        let next = calendar_next_after(
            &spec("Asia/Shanghai", &weekdays, 9, 0, &[], false, &[]),
            from,
        )
        .unwrap()
        .unwrap();
        assert_eq!(next, shanghai_ms(2027, 1, 1, 9, 0));
        // Friday 09:05: the next workday is Monday.
        let after_friday = shanghai_ms(2027, 1, 1, 9, 5);
        let next = calendar_next_after(
            &spec("Asia/Shanghai", &weekdays, 9, 0, &[], false, &[]),
            after_friday,
        )
        .unwrap()
        .unwrap();
        let tz: Tz = "Asia/Shanghai".parse().unwrap();
        let local = Utc.timestamp_millis_opt(next).unwrap().with_timezone(&tz);
        assert_eq!(local.weekday().num_days_from_sunday(), 1, "Monday expected");
    }

    #[test]
    fn month_end_resolves_each_month_including_non_leap_february() {
        let utc_ms = |year: i32, month: u32, day: u32, hour: u32, minute: u32| -> i64 {
            let date = chrono::NaiveDate::from_ymd_opt(year, month, day).unwrap();
            let naive = chrono::NaiveDateTime::new(
                date,
                chrono::NaiveTime::from_hms_opt(hour, minute, 0).unwrap(),
            );
            Utc.from_utc_datetime(&naive).timestamp_millis()
        };
        let next = calendar_next_after(
            &spec("UTC", &[], 9, 0, &[], true, &[]),
            utc_ms(2026, 1, 15, 9, 0),
        )
        .unwrap()
        .unwrap();
        let date = Utc.timestamp_millis_opt(next).unwrap().date_naive();
        assert_eq!(date, chrono::NaiveDate::from_ymd_opt(2026, 1, 31).unwrap());
        // From Jan 31 10:00 UTC the January occurrence is past: the next
        // month-end is Feb 28 (2026 is not leap).
        let next = calendar_next_after(
            &spec("UTC", &[], 9, 0, &[], true, &[]),
            utc_ms(2026, 1, 31, 10, 0),
        )
        .unwrap()
        .unwrap();
        let date = Utc.timestamp_millis_opt(next).unwrap().date_naive();
        assert_eq!(date, chrono::NaiveDate::from_ymd_opt(2026, 2, 28).unwrap());
        // March then lands on the 31st.
        let next = calendar_next_after(
            &spec("UTC", &[], 9, 0, &[], true, &[]),
            utc_ms(2026, 2, 28, 10, 0),
        )
        .unwrap()
        .unwrap();
        let date = Utc.timestamp_millis_opt(next).unwrap().date_naive();
        assert_eq!(date, chrono::NaiveDate::from_ymd_opt(2026, 3, 31).unwrap());
    }

    #[test]
    fn dst_gap_shifts_forward_and_dst_repeat_takes_the_earlier_instant() {
        // America/New_York, 2026-03-08: 02:00 -> 03:00. A 02:30 daily schedule
        // has no 02:30 local instant that day; it shifts to 03:30 EDT.
        let from = shanghai_ms(2026, 3, 7, 20, 0);
        let next =
            calendar_next_after(&spec("America/New_York", &[], 2, 30, &[], false, &[]), from)
                .unwrap()
                .unwrap();
        let tz: Tz = "America/New_York".parse().unwrap();
        let expected = tz
            .from_local_datetime(&chrono::NaiveDateTime::new(
                chrono::NaiveDate::from_ymd_opt(2026, 3, 8).unwrap(),
                chrono::NaiveTime::from_hms_opt(3, 30, 0).unwrap(),
            ))
            .earliest()
            .unwrap()
            .with_timezone(&Utc)
            .timestamp_millis();
        assert_eq!(next, expected);

        // 2026-11-01: 01:30 happens twice (EDT then EST). The earlier
        // instant must be chosen.
        let from = shanghai_ms(2026, 10, 31, 20, 0);
        let next =
            calendar_next_after(&spec("America/New_York", &[], 1, 30, &[], false, &[]), from)
                .unwrap()
                .unwrap();
        let earliest = tz
            .from_local_datetime(&chrono::NaiveDateTime::new(
                chrono::NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(),
                chrono::NaiveTime::from_hms_opt(1, 30, 0).unwrap(),
            ))
            .earliest()
            .unwrap()
            .with_timezone(&Utc)
            .timestamp_millis();
        assert_eq!(next, earliest);
    }

    #[test]
    fn invalid_specs_are_refused_and_system_timezone_is_irrelevant() {
        assert!(calendar_next_after(&spec("Not/AZone", &[], 9, 0, &[], false, &[]), 0).is_err());
        assert!(calendar_next_after(&spec("UTC", &[], 24, 0, &[], false, &[]), 0).is_err());
        assert!(calendar_next_after(&spec("UTC", &[7], 9, 0, &[], false, &[]), 0).is_err());
        assert!(
            calendar_next_after(&spec("UTC", &[], 9, 0, &[0], false, &[]), 0).is_err(),
            "day 0 is invalid"
        );
        // The stored IANA name, not the ambient system zone, decides meaning:
        // with TZ set to a different zone, the UTC instant of "09:00 in
        // Shanghai" is unchanged.
        let from = shanghai_ms(2026, 5, 4, 0, 0);
        let with_tz = {
            // SAFETY: single-threaded test-scoped env mutation; the schedule
            // computation never reads the ambient zone, which is the point.
            unsafe {
                std::env::set_var("TZ", "America/New_York");
            }
            let result =
                calendar_next_after(&spec("Asia/Shanghai", &[], 9, 0, &[], false, &[]), from);
            unsafe {
                std::env::remove_var("TZ");
            }
            result
        };
        assert_eq!(with_tz.unwrap().unwrap(), shanghai_ms(2026, 5, 4, 9, 0));
    }
}
