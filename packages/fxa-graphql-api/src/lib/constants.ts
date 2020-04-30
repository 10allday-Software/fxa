/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Token } from 'typedi';
import { AppConfig } from '../config';
import { Redis } from 'ioredis';
import { Logger } from 'mozlog';
import { UserLookupFn } from './user';

export const configContainerToken = new Token<AppConfig>();
export const redisContainerToken = new Token<Redis>();
export const loggerContainerToken = new Token<Logger>();
export const userLookupFnContainerToken = new Token<UserLookupFn>();
