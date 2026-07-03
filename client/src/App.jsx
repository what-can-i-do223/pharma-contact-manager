// ============================================================================
// App.jsx — layout + a hand-rolled hash router
// ============================================================================
//
// WHY NO react-router: this app has exactly three screens and no nested
// layouts. Hash routing (#/, #/new, #/contacts/<id>) is ~20 lines, needs no
// server configuration (the fragment never reaches the server), and every
// line of it can be explained on camera. A router library would be the
// right call at five+ screens with guards/nesting — not here.
import { useEffect, useState } from 'react';
import ContactList from './pages/ContactList.jsx';
import ContactDetail from './pages/ContactDetail.jsx';
import NewContact from './pages/NewContact.jsx';
import OrdersPage from './pages/OrdersPage.jsx';

// Subscribes to the URL fragment. hashchange fires on every <a href="#/...">
// click and on back/forward, so plain anchors ARE our navigation — no
// custom Link component needed.
function useHashPath() {
  const [path, setPath] = useState(window.location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setPath(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

// The route table, as a plain function: first match wins, unknown paths fall
// back to the list (harmless for a 3-screen app; a real 404 page would be
// over-building).
function Screen({ path }) {
  if (path === '/new') return <NewContact />;
  if (path === '/orders') return <OrdersPage />;

  const contactMatch = path.match(/^\/contacts\/([0-9a-f-]+)$/i);
  if (contactMatch) return <ContactDetail id={contactMatch[1]} />;

  return <ContactList />;
}

export default function App() {
  const path = useHashPath();

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">Pharma Contact Manager</a>
        <nav>
          <a href="#/" className={path === '/' ? 'active' : ''}>Contacts</a>
          <a href="#/orders" className={path === '/orders' ? 'active' : ''}>Orders</a>
          <a href="#/new" className={path === '/new' ? 'active' : ''}>+ New contact</a>
        </nav>
      </header>
      <main>
        <Screen path={path} />
      </main>
    </div>
  );
}
