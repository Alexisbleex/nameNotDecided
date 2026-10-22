import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { Layout, Loader, StatusBadge, CalendarView, ConfirmDialog, useLoad, fmt } from '../components/ui.jsx';
import { useNotifications } from '../context/NotificationContext.jsx';

export function InterviewerDashboard() {
  const [p] = useLoad(() => api('GET', '/interviewer/proposals'));
  return (
    <Layout>
      <h1>Interviewer Hall</h1>
      <div className="card"><p className="big">{p ? p.length : '…'} proposal(s) awaiting your confirmation</p>
        <a href="#/interviewer/proposals">Review proposals</a> · <a href="#/interviewer/availability">Set availability</a></div>
    </Layout>
  );
}

export function ProfileForm() {
  const { flash } = useNotifications();
  const [companies] = useLoad(() => api('GET', '/companies'));
  const [companyId, setCompanyId] = useState('');
  const [tags, setTags] = useState([]);
  const toggle = (s) => setTags(tags.includes(s) ? tags.filter((x) => x !== s) : [...tags, s]);
  const save = async (e) => {
    e.preventDefault();
    if (!companyId || !tags.length) return flash('Pick a company and at least one skill');
    try { await api('PUT', '/interviewer/profile', { companyId: +companyId, skillTags: tags }); flash('Profile saved'); }
    catch (x) { flash(x.message); }
  };
  return (
    <Layout>
      <h1>Profile</h1>
      <form className="card" onSubmit={save}>
        <label>Company
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">Select…</option>
            {(companies || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <fieldset><legend>Skill tags</legend>
          {['Coding', 'Tech', 'HR'].map((s) => (
            <label key={s} className="inline"><input type="checkbox" checked={tags.includes(s)} onChange={() => toggle(s)} /> {s}</label>
          ))}
        </fieldset>
        <button className="primary">Save</button>
      </form>
    </Layout>
  );
}

const DAYS = 7, CELLS = 16; // 09:00-17:00 in 30-min cells, starting tomorrow (UTC)
const cellTime = (d, c) => {
  const t = new Date();
  t.setUTCHours(9, 0, 0, 0);
  t.setUTCDate(t.getUTCDate() + d + 1);
  return new Date(t.getTime() + c * 30 * 60000);
};

export function AvailabilityEditor() {
  const { flash } = useNotifications();
  const [on, setOn] = useState(new Set());
  const mode = useRef(null);
  const key = (d, c) => d + '-' + c;
  const apply = (d, c) => {
    setOn((s) => { const n = new Set(s); mode.current ? n.add(key(d, c)) : n.delete(key(d, c)); return n; });
  };
  useEffect(() => { const up = () => { mode.current = null; }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up); }, []);

  const submit = async () => {
    const slots = [];
    for (let d = 0; d < DAYS; d++) for (let c = 0; c < CELLS; c++) if (on.has(key(d, c))) {
      const s = cellTime(d, c);
      slots.push({ start: s.toISOString().replace('.000Z', 'Z'), end: new Date(s.getTime() + 30 * 60000).toISOString().replace('.000Z', 'Z') });
    }
    try { await api('PUT', '/interviewer/availability', { slots }); flash(`Saved ${slots.length} slots`); }
    catch (x) { flash(x.message); }
  };
  return (
    <Layout>
      <h1>Availability</h1>
      <p className="muted">Click or drag to toggle 30-minute cells. Times are UTC.</p>
      <div className="grid-wrap">
        <div className="grid" style={{ gridTemplateColumns: `70px repeat(${DAYS}, 1fr)` }}>
          <span />
          {Array.from({ length: DAYS }, (_, d) => <strong key={d}>{cellTime(d, 0).toLocaleDateString([], { weekday: 'short', day: 'numeric', timeZone: 'UTC' })}</strong>)}
          {Array.from({ length: CELLS }, (_, c) => [
            <span key={'l' + c} className="muted">{cellTime(0, c).toISOString().slice(11, 16)}</span>,
            ...Array.from({ length: DAYS }, (_, d) => (
              <button key={key(d, c)} className={'cell' + (on.has(key(d, c)) ? ' on' : '')} aria-pressed={on.has(key(d, c))}
                aria-label={`${cellTime(d, c).toUTCString()}`}
                onMouseDown={() => { mode.current = !on.has(key(d, c)); apply(d, c); }}
                onMouseEnter={() => { if (mode.current !== null) apply(d, c); }}
                onClick={(e) => { if (e.detail === 0) { mode.current = !on.has(key(d, c)); apply(d, c); mode.current = null; } }} />
            )),
          ])}
        </div>
      </div>
      <button className="primary" onClick={submit}>Save availability</button>
    </Layout>
  );
}

export function ProposalsReview() {
  const { flash } = useNotifications();
  const [list, e, reload] = useLoad(() => api('GET', '/interviewer/proposals'));
  const [cancelId, setCancelId] = useState(null);
  const [reason, setReason] = useState('');
  const act = async (fn, msg) => { try { await fn(); flash(msg); reload(); } catch (x) { flash(x.message); } };
  return (
    <Layout>
      <h1>Proposals</h1>
      {!list && !e && <Loader />}
      {list && list.length === 0 && <p className="muted">No proposals.</p>}
      {(list || []).map((i) => (
        <div key={i.id} className="card row">
          <span>{i.studentName} · {i.companyName} R{i.roundNo} · {fmt(i.start)} · {i.room}</span>
          <span>
            <button className="primary" onClick={() => act(() => api('POST', `/interviewer/interviews/${i.id}/confirm`, {}), 'Confirmed')}>Confirm</button>
            <button onClick={() => { setCancelId(i.id); setReason(''); }}>Cancel</button>
          </span>
        </div>
      ))}
      {cancelId && (
        <ConfirmDialog title="Cancel interview" confirmLabel="Cancel interview" onCancel={() => setCancelId(null)}
          onConfirm={() => { const id = cancelId; setCancelId(null); act(() => api('POST', `/interviewer/interviews/${id}/cancel`, { reason }), 'Cancelled. Repair has started.'); }}>
          <label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </ConfirmDialog>
      )}
    </Layout>
  );
}

export function ResultsEntry() {
  const { flash } = useNotifications();
  const from = new Date().toISOString(), to = new Date(Date.now() + 60 * 864e5).toISOString();
  const [events, e, reload] = useLoad(() => api('GET', `/calendar?from=${from}&to=${to}`));
  const [form, setForm] = useState({});
  const submit = async (id) => {
    const f = form[id] || {};
    if (!f.verdict) return flash('Choose Pass or Fail');
    try { await api('POST', `/interviewer/interviews/${id}/result`, { verdict: f.verdict, score: Number(f.score || 0) }); flash('Result saved'); reload(); }
    catch (x) { flash(x.message); }
  };
  const set = (id, k, v) => setForm({ ...form, [id]: { ...form[id], [k]: v } });
  return (
    <Layout>
      <h1>Enter Results</h1>
      {!events && !e && <Loader />}
      {(events || []).filter((x) => x.status === 'CONFIRMED').map((x) => (
        <div key={x.id} className="card row">
          <span>{x.title} · {fmt(x.start)}</span>
          <span>
            <select aria-label="Verdict" value={(form[x.id] || {}).verdict || ''} onChange={(e) => set(x.id, 'verdict', e.target.value)}>
              <option value="">Verdict…</option><option value="PASS">PASS</option><option value="FAIL">FAIL</option>
            </select>
            <input aria-label="Score" type="number" min="0" max="100" placeholder="Score" onChange={(e) => set(x.id, 'score', e.target.value)} />
            <button className="primary" onClick={() => submit(x.id)}>Save</button>
          </span>
        </div>
      ))}
    </Layout>
  );
}

export const InterviewerCalendar = () => <Layout><h1>Interview Calendar</h1><CalendarView /></Layout>;