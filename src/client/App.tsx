import { Show, SignInButton, SignUpButton, UserButton, useAuth } from '@clerk/react';
import { useEffect, useMemo, useState } from 'react';

type EventItem = { id: string; title: string; description: string; venue: string; startsAt: string; capacity: number; ticketsRemaining: number; priceMinor: number; currency: string; status: string };
type UserProfile = { role: 'CUSTOMER' | 'ORGANIZER' };
const money = (value: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value / 100);
const time = (value: string) => new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));

function AuthControls() {
  return <><Show when="signed-in"><div className="account"><span>Signed in</span><UserButton /></div></Show><Show when="signed-out"><div className="auth-actions"><SignInButton mode="modal"><button className="signin">Sign in <span aria-hidden="true">↗</span></button></SignInButton><SignUpButton mode="modal"><button className="signup">Create account</button></SignUpButton></div></Show></>;
}

function BookingButton({ event, quantity }: { event: EventItem; quantity: number }) {
  const { getToken } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const template = import.meta.env.VITE_CLERK_JWT_TEMPLATE;
  async function book() {
    setBusy(true); setMessage(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const requestBooking = (token: string) => fetch(`/api/v1/events/${event.id}/bookings`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ quantity }) });
      let token = await getToken(template ? { template } : undefined);
      if (!token) throw new Error('Your session could not be verified. Please sign in again.');
      let response = await requestBooking(token);
      if (response.status === 401) {
        // A custom Clerk JWT is cached briefly; retry once with a freshly minted token.
        token = await getToken(template ? { template, skipCache: true } : { skipCache: true });
        if (!token) throw new Error('Your session could not be verified. Please sign in again.');
        response = await requestBooking(token);
      }
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? 'We could not place that booking.');
      setMessage('Booked. Your confirmation email is on its way.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'We could not place that booking.'); } finally { setBusy(false); }
  }
  return <><button className="book" disabled={busy || event.ticketsRemaining === 0} onClick={() => void book()}>{busy ? 'Booking…' : 'Book tickets'} <span aria-hidden="true">→</span></button>{message && <p className="booking-message">{message}</p>}</>;
}

function BookingAction({ event, quantity }: { event: EventItem; quantity: number }) {
  const [role, setRole] = useState<UserProfile['role'] | null>(null);
  const [roleStatus, setRoleStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const { getToken, isSignedIn, userId } = useAuth();
  const template = import.meta.env.VITE_CLERK_JWT_TEMPLATE;
  useEffect(() => {
    if (!isSignedIn) { setRole(null); setRoleStatus('loading'); return; }
    let cancelled = false;
    setRole(null);
    setRoleStatus('loading');
    void (async () => {
      try {
        const token = await getToken(template ? { template, skipCache: true } : { skipCache: true });
        if (!token) throw new Error('Missing authentication token.');
        const response = await fetch('/api/v1/me', { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error('Profile request failed.');
        const body = await response.json() as { data: UserProfile };
        if (!cancelled) { setRole(body.data.role); setRoleStatus('ready'); }
      } catch { if (!cancelled) setRoleStatus('error'); }
    })();
    return () => { cancelled = true; };
  }, [getToken, isSignedIn, template, userId]);
  const bookingControl = roleStatus === 'loading'
    ? <p className="auth-note">Checking account access…</p>
    : roleStatus === 'error'
      ? <p className="booking-message">We could not determine your account type. Refresh and try again.</p>
      : role === 'ORGANIZER'
        ? <p className="auth-note">Organizer account — ticket booking is unavailable.</p>
        : <BookingButton event={event} quantity={quantity} />;
  return <><Show when="signed-in">{bookingControl}</Show><Show when="signed-out"><SignInButton mode="modal"><button className="book" disabled={event.ticketsRemaining === 0}>Sign in to book <span aria-hidden="true">→</span></button></SignInButton></Show></>;
}

export function App({ authEnabled }: { authEnabled: boolean }) {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => { fetch('/api/v1/events').then(async (response) => { if (!response.ok) throw new Error('Could not load events.'); return response.json() as Promise<{ data: EventItem[] }>; }).then(({ data }) => { setEvents(data); setSelectedId(data[0]?.id ?? null); setStatus('ready'); }).catch(() => setStatus('error')); }, []);
  const selected = useMemo(() => events.find((event) => event.id === selectedId) ?? null, [events, selectedId]);
  const adjust = (delta: number) => setQuantity((current) => Math.max(1, Math.min(10, selected?.ticketsRemaining ?? 10, current + delta)));
  return <div className="app-shell"><header className="topbar"><a className="wordmark" href="/">Venueflow</a><nav aria-label="Primary navigation"><a className="active" href="#events">Events</a><a href="#bookings">My bookings</a><a href="#organize">Organize</a></nav>{authEnabled ? <AuthControls /> : <span className="config-state">Sign-in setup pending</span>}</header><main><section className="masthead" aria-labelledby="page-title"><p className="kicker">LIVE EVENT ROSTER</p><h1 id="page-title">Find a room worth<br />showing up for.</h1><p>Book general-admission tickets with live availability and a confirmed email receipt.</p></section><section className="board" id="events" aria-label="Published events"><div className="board-head"><div><p className="kicker">WHAT'S ON</p><h2>Event roster</h2></div><span className="count">{events.length} live</span></div><div className="board-grid"><div className="roster" role="list">{status === 'loading' && <p className="state">Loading the roster…</p>}{status === 'error' && <p className="state error">The event roster is unavailable. Refresh to try again.</p>}{status === 'ready' && events.length === 0 && <p className="state">No published events yet. An organizer can publish one from the API.</p>}{events.map((event) => <button className={`event-row ${event.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(event.id); setQuantity(1); }} key={event.id} role="listitem"><time dateTime={event.startsAt}>{time(event.startsAt)}</time><span className="event-copy"><strong>{event.title}</strong><small>{event.description}</small></span><span className="venue">{event.venue}</span><span className={event.ticketsRemaining < 10 ? 'availability limited' : 'availability'}><i />{event.ticketsRemaining} left</span></button>)}</div><aside className="tray" aria-live="polite">{selected ? <><p className="kicker">BOOKING TRAY</p><h2>{selected.title}</h2><p className="tray-meta">{time(selected.startsAt)}<br />{selected.venue}</p><div className="rule" /><div className="ticket-line"><span><strong>General admission</strong><small>{money(selected.priceMinor, selected.currency)} each</small></span><div className="stepper"><button onClick={() => adjust(-1)} disabled={quantity === 1} aria-label="Remove ticket">−</button><output>{quantity}</output><button onClick={() => adjust(1)} disabled={quantity >= Math.min(10, selected.ticketsRemaining)} aria-label="Add ticket">+</button></div></div><div className="total"><span>Subtotal</span><strong>{money(selected.priceMinor * quantity, selected.currency)}</strong></div>{authEnabled ? <BookingAction event={selected} quantity={quantity} /> : <button className="book" disabled>Configure Clerk to book <span aria-hidden="true">→</span></button>}<p className="auth-note">Your booking confirmation is sent asynchronously. Public accounts are customers; organizer access is assigned by the deployment administrator.</p></> : <p className="state">Choose an event to view tickets.</p>}</aside></div></section></main><footer><span>Venueflow</span><span>Atomic inventory · asynchronous email delivery</span></footer></div>;
}
