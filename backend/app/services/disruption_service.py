"""Disruption handling: interviewer cancels -> affected interviews FLAGGED -> repair_task ->
scheduler.reschedule (frozen untouched interviews) -> moves applied in ONE transaction with a new
interview version, INTERVIEW_CHANGED outbox notifications; unresolved students are told to re-pick."""
import logging

from app import db
from app.config import settings
from app.errors import ApiError
from app.services import cache, matching_service, notification_service as notify, views
from app.services.confirm_service import _announce
from app.services.views import ROUND_SKILL

log = logging.getLogger("trials.repair")
MOVE_WEIGHTS = {"movePenalty": 500, "swapInterviewer": 50, "nextRanked": 150, "nearestSlot": 300}
LIVE = ("PROPOSED", "INTERVIEWER_CONFIRMED", "CONFIRMED", "FLAGGED")


def cancel_interview(interview_id: int, interviewer_id: int, reason: str) -> dict:
    """POST /interviewer/interviews/{id}/cancel. Returns {flaggedInterviews:[id]} and enqueues repair."""
    with db.transaction() as conn:
        iv = conn.execute("SELECT id, status, student_id FROM interviews WHERE id = %s FOR UPDATE", (interview_id,)).fetchone()
        if not iv:
            raise ApiError("NOT_FOUND", "Interview not found")
        mine = conn.execute("SELECT slot_id FROM interview_panel WHERE interview_id = %s AND interviewer_id = %s",
                            (interview_id, interviewer_id)).fetchone()
        if not mine:
            raise ApiError("FORBIDDEN", "You are not on this interview")
        if iv["status"] not in LIVE or iv["status"] == "FLAGGED":
            if iv["status"] == "FLAGGED":
                return {"flaggedInterviews": [interview_id]}          # idempotent re-cancel
            raise ApiError("VALIDATION", f"Interview is {iv['status']} and cannot be cancelled")
        slot_id = mine["slot_id"]
        # everything resting on that slot is affected (normally just this interview)
        affected = [r["interview_id"] for r in conn.execute(
            "SELECT p.interview_id FROM interview_panel p JOIN interviews i ON i.id = p.interview_id "
            "WHERE p.slot_id = %s AND i.status = ANY(%s) ORDER BY p.interview_id FOR UPDATE OF i", (slot_id, list(LIVE))).fetchall()]
        conn.execute("UPDATE interviews SET status = 'FLAGGED' WHERE id = ANY(%s)", (affected,))
        conn.execute("UPDATE availability_slots SET status = 'HELD' WHERE id = %s", (slot_id,))   # unusable from now on
        for it in views.interviews_by_ids(conn, affected):
            notify.enqueue_notify(conn, it["studentId"], "INTERVIEW_CHANGED",
                                  "Your interviewer had to cancel — we are rescheduling you now.", it["id"])
    notify.kick_outbox()
    try:
        from workers.tasks import repair_task
        repair_task.delay(affected, [slot_id], interviewer_id, reason or "")
    except Exception as exc:  # noqa: BLE001
        log.error("could not enqueue repair for %s: %s", affected, exc)
    return {"flaggedInterviews": affected}


def _build_input(conn, company_id: int, round_no: int, cancelled_interviewer: int, cancelled_slots: list) -> dict:
    cur = conn.execute(
        """SELECT i.id, i.student_id, i.room_id FROM interviews i
           WHERE i.company_id = %s AND i.round_no = %s AND i.status = ANY(%s) ORDER BY i.id""",
        (company_id, round_no, list(LIVE))).fetchall()
    current = []
    for c in cur:
        panel = conn.execute("SELECT interviewer_id, slot_id FROM interview_panel WHERE interview_id = %s ORDER BY interviewer_id",
                             (c["id"],)).fetchall()
        if not panel:
            continue
        current.append({"interviewId": c["id"], "studentId": c["student_id"], "slotId": panel[0]["slot_id"],
                        "interviewerIds": [p["interviewer_id"] for p in panel], "roomId": c["room_id"], "roundNo": round_no})
    slot_rows = conn.execute(
        """SELECT s.id, s.interviewer_id, s.start_ts, s.end_ts, s.room_id, s.status, iv.skill_tags
           FROM availability_slots s JOIN interviewers iv ON iv.user_id = s.interviewer_id
           WHERE iv.company_id = %s AND s.start_ts > now() - interval '1 day' ORDER BY s.start_ts, s.id""", (company_id,)).fetchall()
    shape = lambda s: {"slotId": s["id"], "interviewerId": s["interviewer_id"], "start": db.iso(s["start_ts"]),
                       "end": db.iso(s["end_ts"]), "roomId": s["room_id"], "skillTags": list(s["skill_tags"])}
    skill = ROUND_SKILL[round_no]
    now = conn.execute("SELECT now() AS n").fetchone()["n"]
    free = [shape(s) for s in slot_rows if s["status"] == "FREE" and s["room_id"] is not None
            and s["id"] not in cancelled_slots and s["start_ts"] > now
            and skill in s["skill_tags"]]
    students = []
    for c in current:
        prefs = conn.execute(
            "SELECT slot_id, rank FROM slot_preferences WHERE student_id = %s AND company_id = %s AND round_no = %s ORDER BY rank",
            (c["studentId"], company_id, round_no)).fetchall()
        students.append({"studentId": c["studentId"], "prefs": [{"slotId": p["slot_id"], "rank": p["rank"]} for p in prefs]})
    return {
        "roundNo": round_no,
        "slots": [shape(s) for s in slot_rows],
        "rooms": [{"roomId": r} for r in sorted({s["room_id"] for s in slot_rows if s["room_id"]})],
        "students": students,
        "panelRequirements": {"companyId": company_id, "requiredSkills": []},
        "weights": dict(matching_service.DEFAULT_WEIGHTS),
        "currentInterviews": current,
        "cancelled": {"interviewerId": cancelled_interviewer, "slotIds": list(cancelled_slots)},
        "freeSlots": free,
        "moveWeights": dict(MOVE_WEIGHTS),
    }


def repair(interview_ids: list, cancelled_slots: list, cancelled_interviewer: int, reason: str = "") -> dict:
    """Worker-side repair. Safe to retry: it only acts on interviews still FLAGGED."""
    _, reschedule = matching_service.get_solver()
    touched = set()
    summary = {"moved": 0, "unresolved": 0}
    with db.transaction() as conn:
        groups = {}
        for r in conn.execute("SELECT id, company_id, round_no FROM interviews WHERE id = ANY(%s) AND status = 'FLAGGED' ORDER BY id FOR UPDATE",
                              (interview_ids,)).fetchall():
            groups.setdefault((r["company_id"], r["round_no"]), []).append(r["id"])
        if not groups:
            return summary
        conn.execute("SET CONSTRAINTS ALL DEFERRED")        # moves may shuffle rows; checked at commit
        for (company_id, round_no), flagged in groups.items():
            conn.execute("SELECT pg_advisory_xact_lock(%s)", (4200 + round_no,))
            data = _build_input(conn, company_id, round_no, cancelled_interviewer, cancelled_slots)
            committed = {r["interview_id"] for r in conn.execute(
                "SELECT DISTINCT interview_id FROM interview_panel WHERE interview_id = ANY(%s) AND booked", (flagged,)).fetchall()}
            result = reschedule(data, settings.reschedule_time_limit)
            moves = {m["interviewId"]: m for m in result.get("moves", [])}
            cancelled_set = set(cancelled_slots)

            # phase A: release old rows of every flagged interview
            for iid in flagged:
                old = conn.execute("SELECT slot_id, interviewer_id FROM interview_panel WHERE interview_id = %s", (iid,)).fetchall()
                conn.execute("UPDATE interview_panel SET booked = false WHERE interview_id = %s", (iid,))
                for o in old:
                    if o["slot_id"] not in cancelled_set:
                        conn.execute("UPDATE availability_slots SET status = 'FREE' WHERE id = %s", (o["slot_id"],))

            # phase B: apply moves / unresolved
            for iid in flagged:
                m = moves.get(iid)
                before = views.interview_by_id(conn, iid)
                old_panel_ids = {p["interviewerId"] for p in before["panel"]}
                if not m or m["strategy"] == "UNRESOLVED" or m.get("toSlotId") is None:
                    conn.execute("DELETE FROM interview_panel WHERE interview_id = %s", (iid,))
                    conn.execute("UPDATE interviews SET status = 'CANCELLED', version = version + 1 WHERE id = %s", (iid,))
                    conn.execute("UPDATE slot_preferences SET status = 'UNMATCHED' WHERE student_id = %s AND company_id = %s AND round_no = %s",
                                 (before["studentId"], company_id, round_no))
                    notify.enqueue_notify(conn, before["studentId"], "INTERVIEW_CANCELLED",
                                          "We could not find a replacement slot — please choose new slots.", iid)
                    for pid in old_panel_ids - {cancelled_interviewer}:
                        notify.enqueue_notify(conn, pid, "INTERVIEW_CANCELLED",
                                              f"Interview with {before['studentName']} was cancelled.", iid)
                    summary["unresolved"] += 1
                    continue
                to = conn.execute("SELECT s.id, s.interviewer_id, s.start_ts, s.end_ts, s.room_id FROM availability_slots s WHERE s.id = %s FOR UPDATE",
                                  (m["toSlotId"],)).fetchone()
                interviewers = m.get("newInterviewerIds") or [to["interviewer_id"]]
                is_committed = iid in committed
                conn.execute("DELETE FROM interview_panel WHERE interview_id = %s", (iid,))
                for iv_id in interviewers:
                    s = to if iv_id == to["interviewer_id"] else conn.execute(
                        "SELECT id FROM availability_slots WHERE interviewer_id = %s AND start_ts = %s FOR UPDATE", (iv_id, to["start_ts"])).fetchone()
                    conn.execute(
                        "INSERT INTO interview_panel (interview_id, interviewer_id, slot_id, start_ts, end_ts, booked, confirmed) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                        (iid, iv_id, s["id"], to["start_ts"], to["end_ts"], is_committed, is_committed))
                    conn.execute("UPDATE availability_slots SET status = %s WHERE id = %s",
                                 ("BOOKED" if is_committed else "HELD", s["id"]))
                conn.execute(
                    "UPDATE interviews SET start_ts = %s, end_ts = %s, room_id = %s, status = %s, version = version + 1 WHERE id = %s",
                    (to["start_ts"], to["end_ts"], to["room_id"], "CONFIRMED" if is_committed else "PROPOSED", iid))
                after = views.interview_by_id(conn, iid)
                new_ids = {p["interviewerId"] for p in after["panel"]}
                _announce(conn, after, "INTERVIEW_CHANGED", "Interview rescheduled")
                for pid in old_panel_ids - new_ids - {cancelled_interviewer}:
                    notify.enqueue_notify(conn, pid, "INTERVIEW_CHANGED",
                                          f"You were replaced on the interview with {after['studentName']}.", iid)
                summary["moved"] += 1
            touched.add(company_id)

        # the cancelled slots are history now
        conn.execute("DELETE FROM availability_slots WHERE id = ANY(%s) AND NOT EXISTS "
                     "(SELECT 1 FROM interview_panel p WHERE p.slot_id = availability_slots.id)", (list(cancelled_slots),))
    for cid in touched:
        cache.invalidate_company_slots(cid)
    notify.kick_outbox()
    return summary
