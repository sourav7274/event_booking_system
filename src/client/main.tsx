import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import { App } from './App';
import './styles.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function Root() {
  if (!publishableKey) return <App authEnabled={false} />;
  return <ClerkProvider publishableKey={publishableKey}><App authEnabled /></ClerkProvider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
