/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import React from 'react';
import { render } from 'react-dom';
import './index.scss';
import App from './components/App';

export async function init() {
  // TODO: Configure Sentry logging
  // if (config.sentry.dsn) {
  //   sentryMetrics.configure(config.sentry.dsn, config.version);
  // }

  render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
    document.getElementById('root')
  );
}

init().then(
  () => {},
  error => {
    console.log('Error initializing FXA Settings', error);
  }
);
