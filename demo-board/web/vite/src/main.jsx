import React from 'react';
import ReactDOM from 'react-dom/client';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import '@xyflow/react/dist/style.css';
import './theme.css';
import { loadAppConfig } from './lib/appConfig.js';

async function bootstrap() {
  await loadAppConfig();
  const { default: App } = await import('./App.jsx');

  ReactDOM.createRoot(document.getElementById('root')).render(
    <App />
  );
}

bootstrap();
