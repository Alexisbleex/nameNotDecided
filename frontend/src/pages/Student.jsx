import { useEffect, useState } from 'react';
import { api, downloadIcs } from '../api/client.js';
import { navigate } from '../router.js';
import { Layout, Loader, StatusBadge, SlotCard, CalendarView, useLoad, fmt } from '../components/ui.jsx';
import { useNotifications } from '../context/NotificationContext.jsx';

export function StudentDashboard() {
  const [d, e, reload] = useLoad(() => api('GET', '/student/status'));
  useEffect(() => { const t = setInterval(reload, 8000); return () => clearInterval(t); }, []);
  return (
    <Layout>
      <h1>Your Trials</h1>
      {!d && !e && <Loader />}
      {e && <p className="err">{e.message}</p>}
      {d && (
        <>
          <section className="card" aria-live="polite"><h2>Status</h2><p className="big">{d.statusText}</p></section>
          <section className="card"><h2>Preferences</h2>
            {d.preferences.length ? (
              <ol>{d.preferences.map((p) => (
                <li key={p.slotId}>Rank {p.rank}: {p.start ? fmt(p.start) : 'Slot ' + p.slotId} <StatusBadge status={p.status} /></li>
              ))}</ol>
            ) : <p>None yet. <a href="#/student/companies">Browse companies</a></p>}
          </section>
          <section className="card"><h2>Interviews and results</h2>
            {d.interviews.length === 0 && <p className="muted">No interviews yet.</p>}
            {d.interviews.map((i) => (
              <div key={i.id} className="row">
                <span>{i.companyName} · Round {i.roundNo} · {fmt(i.start)} · {i.room} · {i.panel.map((x) => x.name).join(', ')}</span>
                <StatusBadge status={i.status} />
                <button onClick={() => downloadIcs(i.id)}>Download .ics</button>
              </div>
            ))}
          </section>
        </>
      )}
    </Layout>
  );
}

export function CompanyBrowser() {
  const [list, e] = useLoad(() => api('GET', '/companies'));
  const [q, setQ] = useState('');
  const shown = (list || []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Layout>
      <h1>Companies</h1>
      <label>Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Company name" /></label>
      {!list && !e && <Loader />}
      {e && <p className="err">{e.message}</p>}
      {shown.map((c) => (
        <div key={c.id} className="card row">
          <div><strong>{c.name}</strong><div className="muted">Rounds: {c.roundsConfig.join(' → ')} · {c.openSlotCount} open slots</div></div>
          <button className="primary" onClick={() => navigate('/student/slots/' + c.id)}>View slots</button>
        </div>
      ))}
    </Layout>
  );
}

export function SlotPicker({ param }) {
  const { flash } = useNotifications();
  const [round, setRound] = useState(1);
  const [chosen, setChosen] = useState([]);
  const [slots, e, reload] = useLoad(() => api('GET', `/companies/${param}/slots?roundNo=${round}`), [round]);
  const isChosen = (s) => chosen.some((c) => c.slotId === s.slotId);

  const toggle = (s) => {
    if (isChosen(s)) return setChosen(chosen.filter((c) => c.slotId !== s.slotId));
    if (chosen.length >= 3) return flash('You can pick at most 3 slots');
    setChosen([...chosen, s]);
  };
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= chosen.length) return;
    const c = [...chosen];
    [c[i], c[j]] = [c[j], c[i]];
    setChosen(c);
  };
  const submit = async () => {
    try {
      await api('POST', '/student/preferences', {
        companyId: +param, roundNo: round, choices: chosen.map((s, i) => ({ slotId: s.slotId, rank: i + 1 })),
      });
      flash('Pending. Your preferences are saved.');
      navigate('/student/dashboard');
    } catch (x) {
      flash(x.code === 'SLOT_TAKEN' ? 'Someone just took that slot. Please pick another.' : x.message);
      setChosen([]);
      reload();
    }
  };
  return (
    <Layout>
      <h1>Choose up to 3 slots</h1>
      <label>Round
        <select value={round} onChange={(e) => { setRound(+e.target.value); setChosen([]); }}>
          <option value={1}>1 · Coding</option><option value={2}>2 · Tech</option><option value={3}>3 · HR</option>
        </select>
      </label>
      <section className="card"><h2>Your ranking</h2>
        {chosen.length === 0 && <p className="muted">Select slots below. Order = rank (1 is most wanted).</p>}
        {chosen.map((s, i) => (
          <div key={s.slotId} className="row">
            <span>#{i + 1} {fmt(s.start)}</span>
            <span>
              <button aria-label={`Move rank ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button aria-label={`Move rank ${i + 1} down`} disabled={i === chosen.length - 1} onClick={() => move(i, 1)}>↓</button>
            </span>
          </div>
        ))}
        <button className="primary" disabled={!chosen.length} onClick={submit}>Submit preferences</button>
      </section>
      {!slots && !e && <Loader />}
      {e && <p className="err">{e.message}</p>}
      {slots && slots.length === 0 && <p>No open slots for this round.</p>}
      {(slots || []).map((s) => (
        <SlotCard key={s.slotId} slot={s}>
          <button className={isChosen(s) ? '' : 'primary'} onClick={() => toggle(s)}>{isChosen(s) ? 'Remove' : 'Select'}</button>
        </SlotCard>
      ))}
    </Layout>
  );
}

export const StudentCalendar = () => <Layout><h1>My Calendar</h1><CalendarView /></Layout>;

export function NotificationsPage() {
  const { items, markRead } = useNotifications();
  return (
    <Layout>
      <h1>Notifications</h1>
      {items.length === 0 && <p className="muted">Nothing yet.</p>}
      {items.map((n) => (
        <div key={n.id} className={'card row' + (n.readAt ? ' read' : '')}>
          <span><StatusBadge status={n.type} /> {n.payload.message}</span>
          {!n.readAt && <button onClick={() => markRead(n.id)}>Mark read</button>}
        </div>
      ))}
    </Layout>
  );
}