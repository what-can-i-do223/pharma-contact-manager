// Entry point: mount <App/> into the #root div from index.html.
// StrictMode double-invokes effects in dev to surface bugs early; it has no
// effect in production builds.
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
