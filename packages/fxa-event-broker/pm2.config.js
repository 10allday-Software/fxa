/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PATH = process.env.PATH.split(':')
  .filter((p) => !p.includes(process.env.TMPDIR))
  .join(':');

module.exports = {
  apps: [
    {
      name: 'event-broker',
      script: 'nest start --debug=9180 --watch',
      cwd: __dirname,
      max_restarts: '1',
      env: {
        FIRESTORE_EMULATOR_HOST: 'localhost:9090',
        METRIC_HOST: 'localhost',
        NODE_ENV: 'development',
        PATH,
        PUBSUB_AUDIENCE: 'example.com',
        PUBSUB_EMULATOR_HOST: 'localhost:8085',
        PUBSUB_PROXY_PORT: '8093',
        TS_NODE_FILES: 'true',
        TS_NODE_TRANSPILE_ONLY: 'true',
        WORKER_HOST: '0.0.0.0',
      },
      filter_env: ['npm_'],
      watch: ['src', 'config'],
      min_uptime: '2m',
      time: true,
    },
  ],
};
