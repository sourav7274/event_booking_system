/*
THESIS: A live venue roster makes availability and the next booking action visible together; it refuses a generic event-card marketplace.
OWN-WORLD: Ink-blue shell, paper-white roster, ruled rows, cobalt action, and condensed event names.
STORY: A customer scans what is on, chooses an event, and sees ticket quantity and total without losing the roster.
FIRST VIEWPORT: Header above a two-column roster and booking tray; event rows own the central field and the primary booking action sits in the tray.
FORM: Venue board with booking tray, direction seed 7a84b05b; generated composition was used as a non-literal hierarchy study.
*/
import { useEffect, useMemo, useState } from 'react';

type EventItem = { id: string; title: string; description: string; venue: string; startsAt: string; capacity: number; ticketsRemaining: number; priceMinor: number; currency: string; status: string };

const money = (value: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value / 100);
const time = (value: string) => new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));

export function App() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    fetch('/api/v1/events').then(async (response) => {
      if (!response.ok) throw new Error('Could not load events.');
      return response.json() as Promise<{ data: EventItem[] }>;
    }).then(({ data }) => { setEvents(data); setSelectedId(data[0]?.id ?? null); setStatus('ready'); }).catch(() => setStatus('error'));
  }, []);

  const selected = useMemo(() => events.find((event) => event.id === selectedId) ?? null, [events, selectedId]);
  const adjust = (delta: number) => setQuantity((current) => Math.max(1, Math.min(10, selected?.ticketsRemaining ?? 10, current + delta)));

  return <div className="app-shell">
    <header className="topbar">
      <a className="wordmark" href="/">Venueflow</a>
      <nav aria-label="Primary navigation"><a className="active" href="#events">Events</a><a href="#bookings">My bookings</a><a href="#organize">Organize</a></nav>
      <a className="signin" href="#signin">Sign in <span aria-hidden="true">↗</span></a>
    </header>
    <main>
      <section className="masthead" aria-labelledby="page-title">
        <p className="kicker">LIVE EVENT ROSTER</p>
        <h1 id="page-title">Find a room worth<br />showing up for.</h1>
        <p>Book general-admission tickets with live availability and a confirmed email receipt.</p>
      </section>
      <section className="board" id="events" aria-label="Published events">
        <div className="board-head"><div><p className="kicker">WHAT'S ON</p><h2>Event roster</h2></div><span className="count">{events.length} live</span></div>
        <div className="board-grid">
          <div className="roster" role="list">
            {status === 'loading' && <p className="state">Loading the roster…</p>}
            {status === 'error' && <p className="state error">The event roster is unavailable. Refresh to try again.</p>}
            {status === 'ready' && events.length === 0 && <p className="state">No published events yet. An organizer can publish one from the API.</p>}
            {events.map((event) => <button className={`event-row ${event.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(event.id); setQuantity(1); }} key={event.id} role="listitem">
              <time dateTime={event.startsAt}>{time(event.startsAt)}</time>
              <span className="event-copy"><strong>{event.title}</strong><small>{event.description}</small></span>
              <span className="venue">{event.venue}</span>
              <span className={event.ticketsRemaining < 10 ? 'availability limited' : 'availability'}><i />{event.ticketsRemaining} left</span>
            </button>)}
          </div>
          <aside className="tray" aria-live="polite">
            {selected ? <>
              <p className="kicker">BOOKING TRAY</p><h2>{selected.title}</h2>
              <p className="tray-meta">{time(selected.startsAt)}<br />{selected.venue}</p>
              <div className="rule" />
              <div className="ticket-line"><span><strong>General admission</strong><small>{money(selected.priceMinor, selected.currency)} each</small></span><div className="stepper"><button onClick={() => adjust(-1)} disabled={quantity === 1} aria-label="Remove ticket">−</button><output>{quantity}</output><button onClick={() => adjust(1)} disabled={quantity >= Math.min(10, selected.ticketsRemaining)} aria-label="Add ticket">+</button></div></div>
              <div className="total"><span>Subtotal</span><strong>{money(selected.priceMinor * quantity, selected.currency)}</strong></div>
              <button className="book" disabled={selected.ticketsRemaining === 0}>Sign in to book <span aria-hidden="true">→</span></button>
              <p className="auth-note">Clerk sign-in is activated after deployment configuration. Your booking confirmation is sent asynchronously.</p>
            </> : <p className="state">Choose an event to view tickets.</p>}
          </aside>
        </div>
      </section>
    </main>
    <footer><span>Venueflow</span><span>Atomic inventory · asynchronous email delivery</span></footer>
  </div>;
}
