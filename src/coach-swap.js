// Reassign the coach on a run of sessions at once.
//
// A workout starts every ten minutes here, so a single day holds around 86
// sessions and an evening shift is a few dozen of them. Swapping a coach for
// "Thursday evening" through the Arbox UI means opening each session in turn -
// which is why it does not get done. This takes a date, a window of hours and a
// coach, and does the lot.
//
// preview() and apply() take identical arguments and select identical sessions,
// so what is confirmed on screen is exactly what changes. Nothing is written
// until apply() is called.
const arbox = require("./arbox");

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function findSessions({ date, fromTime, toTime, currentCoachId }) {
  const result = await arbox.getSchedule({ from_date: date, to_date: date, limit: 200 });
  const sessions = result.data || [];

  const from = toMinutes(fromTime);
  const to = toMinutes(toTime);

  return sessions.filter((s) => {
    const start = toMinutes(s.start_time);
    if (start === null) return false;
    if (from !== null && start < from) return false;
    if (to !== null && start > to) return false;
    // Optional: only sessions currently taught by one particular coach, for
    // when somebody calls in sick rather than a whole shift being reshuffled.
    if (currentCoachId) {
      const staffId = s.staff_member?.user_id ?? s.staff_member?.id;
      if (String(staffId) !== String(currentCoachId)) return false;
    }
    return true;
  });
}

async function preview(params) {
  const sessions = await findSessions(params);
  return {
    count: sessions.length,
    sessions: sessions.map((s) => ({
      scheduleId: s.schedule_id,
      time: String(s.start_time || "").slice(0, 5),
      name: s.session_name,
      currentCoach: s.staff_member?.name || s.staff_member?.first_name || "—",
    })),
  };
}

// Arbox returns HTTP 500 on this endpoint even when the update succeeds. We
// confirmed it: 36 PATCH calls all returned 500, and a GET afterwards showed
// every one of the 36 sessions correctly reassigned. Their support has been
// told; until they fix it, believing the status code would report a completed
// swap as a total failure - and tempt anyone into retrying an operation that
// already happened.
//
// So the result is verified against the data rather than the response: after
// the writes, re-read the schedule and count who actually teaches those
// sessions now. That is true regardless of what the API claims.
async function apply(params) {
  const { newCoachId } = params;
  if (!newCoachId) throw new Error("צריך לבחור מאמן חדש");

  const sessions = await findSessions(params);
  const attempted = sessions.map((s) => s.schedule_id);

  for (const s of sessions) {
    try {
      await arbox.updateScheduleStaff(s.schedule_id, Number(newCoachId));
    } catch (e) {
      // Expected while the endpoint misreports - verification below is what counts.
      console.log(`Coach swap: schedule ${s.schedule_id} returned an error, will verify (${e.message.slice(0, 60)})`);
    }
  }

  const after = await findSessions({ ...params, currentCoachId: null });
  const stillWrong = after.filter((s) => {
    if (!attempted.includes(s.schedule_id)) return false;
    const staffId = s.staff_member?.user_id ?? s.staff_member?.id;
    return String(staffId) !== String(newCoachId);
  });

  const changed = attempted.length - stillWrong.length;
  console.log(`Coach swap: ${changed}/${attempted.length} sessions verified as reassigned.`);
  return {
    changed,
    failed: stillWrong.map((s) => ({ scheduleId: s.schedule_id, error: "לא הוחלף" })),
  };
}

module.exports = { preview, apply, findSessions };
