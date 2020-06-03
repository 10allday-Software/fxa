/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const ROOT_DIR = '../..';

const cp = require('child_process');
const { assert } = require('chai');
const path = require('path');
const P = require('bluebird');
const mocks = require(`${ROOT_DIR}/test/mocks`);

const cwd = path.resolve(__dirname, ROOT_DIR);
cp.execAsync = P.promisify(cp.exec);

const log = mocks.mockLog();
const config = require('../../config').getProperties();
const Token = require('../../lib/tokens')(log, config);
const UnblockCode = require('../../lib/crypto/random').base32(
  config.signinUnblock.codeLength
);
const TestServer = require('../test_server');

const twoBuffer16 = Buffer.from(
  '22222222222222222222222222222222',
  'hex'
).toString('hex');
const twoBuffer32 = Buffer.from(
  '2222222222222222222222222222222222222222222222222222222222222222',
  'hex'
).toString('hex');

function createAccount(email, uid) {
  return {
    uid,
    email,
    emailCode: twoBuffer16,
    emailVerified: false,
    verifierVersion: 1,
    verifyHash: twoBuffer32,
    authSalt: twoBuffer32,
    kA: twoBuffer32,
    wrapWrapKb: twoBuffer32,
    tokenVerificationId: twoBuffer16,
  };
}

const account1Mock = createAccount(
  'user1@test.com',
  'acab38ecffeb4a27a8835016dbf1292c'
);

const DB = require('../../lib/db')(config, log, Token, UnblockCode);

describe('scripts/must-reset', async function () {
  this.timeout(20000);

  let db, server;

  before(async () => {
    server = await TestServer.start(config);
    db = await DB.connect(config[config.db.backend]);
    await db.deleteAccount(account1Mock);
  });

  after(async () => {
    await db.deleteAccount(account1Mock);
    return await TestServer.stop(server);
  });

  beforeEach(async () => {
    await db.createAccount(account1Mock);
  });

  afterEach(async () => {
    await db.deleteAccount(account1Mock);
  });

  it('fails if -i is not specified', async () => {
    try {
      await cp.execAsync('node --require ts-node/register scripts/must-reset', {
        cwd,
      });
      assert(false, 'script should have failed');
    } catch (err) {
      assert.include(err.message, 'Command failed');
    }
  });

  it('succeeds', async () => {
    await cp.execAsync(
      `node --require ts-node/register scripts/must-reset -i ./test/scripts/fixtures/accounts.json`,
      { cwd }
    );
    const account = await db.account(account1Mock.uid);
    assert.equal(
      account.authSalt,
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    );
  });
});
