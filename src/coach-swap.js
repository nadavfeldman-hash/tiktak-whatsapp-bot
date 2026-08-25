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

async function apply(params) {
  const { newCoachId } = params;
  if (!newCoachId) throw new Error("צריך לבחור מאמן חדש");

  const sessions = await findSessions(params);
  const changed = [];
  const failed = [];

  for (const s of sessions) {
    try {
      await arbox.updateScheduleStaff(s.schedule_id, Number(newCoachId));
      changed.push(s.schedule_id);
    } catch (e) {
      failed.push({ scheduleId: s.schedule_id, error: e.message });
      console.error(`Coach swap failed for schedule ${s.schedule_id}:`, e.message);
    }
  }

  console.log(`Coach swap: ${changed.length} sessions reassigned, ${failed.length} failed.`);
  return { changed: changed.length, failed };
}

module.exports = { preview, apply, findSessions };
