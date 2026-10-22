import { useEffect, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import { api, downloadIcs } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useNotifications } from '../context/NotificationContext.jsx';

export const fmt = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export function useLoad(fn, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = () => fn().then((x) => { setData(x); setError(null); }).catch(setError);
  useEffect(() => { reload(); }, deps);
  return [data, error, reload];
}

export const Loader = () => <div className="loader" role="status" aria-label="Loading" />;

export const StatusBadge = ({ status }) => (
  <span className={'badge b-' + status}>{String(status).replace(/_/g, ' ')}</span>
);

const NAV = {
  STUDENT: [['dashboard', 'Dashboard'], ['companies', 'Companies'], ['calendar', 'Calendar']],
  INTERVIEWER: [['dashboard', 'Dashboard'], ['profile', 'Profile'], ['availability', 'Availability'],
    ['proposals', 'Proposals'], ['results', 'Results'], ['calendar', 'Calendar']],
  COORDINATOR: [['dashboard', 'Dashboard'], ['matching', 'Matching'], ['notice', 'Notice'], ['calendar', 'Calendar']],
};

export function Navbar() {
  const { user, logout } = useAuth();
  const { unread } = useNotifications();
  const role = user.role.toLowerCase();
  return (
    <header className="nav">
      <strong className="brand">⚜ The Ancient One's Trials</strong>
      <nav aria-label="Main">
        {NAV[user.role].map(([k, label]) => <a key={k} href={`#/${role}/${k}`}>{label}</a>)}
      </nav>
      <span className="grow" />
      <a href={`#/${role}/notifications`} aria-label={`Notifications, ${unread} unread`}>
        🔔{unread > 0 && <span className="dot">{unread}</span>}
      </a>
      <span className="who">{user.name}</span>
      <button onClick={logout}>Log out</button>
    </header>
  );
}

export const Layout = ({ children }) => (<><Navbar /><main className="wrap">{children}</main></>);

export function SlotCard({ slot, children }) {
  return (
    <div className="card slot">
      <div>
        <strong>{fmt(slot.start)}</strong> to {new Date(slot.end).toLocaleTimeString([], { timeStyle: 'short' })}
        <div className="muted">{slot.interviewerNames.join(', ')} · {slot.room}</div>
      </div>
      <div className="actions">{children}</div>
    </div>
  );
}

export function ConfirmDialog({ title, children, onConfirm, onCancel, confirmLabel = 'Confirm' }) {
  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function CalendarView() {
  const [events, setEvents] = useState([]);
  const [sel, setSel] = useState(null);
  const load = (info) =>
    api('GET', `/calendar?from=${encodeURIComponent(info.startStr)}&to=${encodeURIComponent(info.endStr)}`)
      .then(setEvents).catch(() => {});
  return (
    <>
      <FullCalendar
        plugins={[dayGridPlugin, timeGridPlugin, listPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,listWeek' }}
        events={events}
        datesSet={load}
        eventClick={(e) => setSel(events.find((x) => String(x.id) === e.event.id))}
        height="auto"
      />
      {sel && (
        <ConfirmDialog title={sel.title} confirmLabel="Download .ics" onCancel={() => setSel(null)}
          onConfirm={() => downloadIcs(sel.id)}>
          <p>{fmt(sel.start)}</p>
          <p>Room: {sel.room}</p>
          <p>Interviewers: {sel.interviewerNames.join(', ')}</p>
          <StatusBadge status={sel.status} />
        </ConfirmDialog>
      )}
    </>
  );
}