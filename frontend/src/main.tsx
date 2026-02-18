import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import './i18n'
import App from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
})

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Failsafe: If we are somehow serving the index.html from an /uploads path or /api path, 
// DO NOT boot the app, as this causes infinite recursion in Router.
// Shows a clear error instead.
if (window.location.pathname.startsWith('/uploads/') || window.location.pathname.startsWith('/api/')) {
  document.body.innerHTML = `
    <div style="font-family: sans-serif; padding: 2rem; text-align: center;">
      <h1 style="color: #e11d48;">Backend Error</h1>
      <p>The server responded with the React Application instead of the requested static file or API response.</p>
      <p><strong>Path:</strong> ${window.location.pathname}</p>
      <hr style="margin: 2rem 0; border: 0; border-top: 1px solid #ddd;" />
      <div style="text-align: left; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 1rem; border-radius: 8px;">
        <strong>Troubleshooting (IIS):</strong>
        <ul style="margin-top: 0.5rem; padding-left: 1.5rem;">
           <li>Ensure <strong>Application Request Routing (ARR)</strong> is installed and Proxy is enabled.</li>
           <li>Ensure <strong>URL Rewrite</strong> module is installed.</li>
           <li>Verify <code>web.config</code> rewrite rules are active.</li>
           <li>Check if the file extension (e.g. .config) is blocked by <strong>Request Filtering</strong>.</li>
        </ul>
      </div>
    </div>
  `;
  // Attempt to unregister Service Workers which might be serving this page via cache
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      for (let registration of registrations) {
        registration.unregister();
      }
      // Reload the page to retry without Service Worker
      window.location.reload();
    });
  } else {
    throw new Error('Stopped React boot on invalid path');
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
