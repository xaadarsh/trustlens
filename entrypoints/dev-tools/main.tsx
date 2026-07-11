import React from 'react';
import ReactDOM from 'react-dom/client';
import DevTools from './DevTools.tsx';
import './DevTools.css';

if (!import.meta.env.DEV) {
  throw new Error('Dev tools page should only be available in development mode.');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DevTools />
  </React.StrictMode>,
);
