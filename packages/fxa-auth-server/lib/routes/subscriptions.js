/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const error = require('../error');
const isA = require('joi');
const ScopeSet = require('../../../fxa-shared').oauth.scopes;
const validators = require('./validators');
const { metadataFromPlan } = require('./utils/subscriptions');

const stripe = require('../payments/stripe');

const SUBSCRIPTIONS_MANAGEMENT_SCOPE =
  'https://identity.mozilla.com/account/subscriptions';

async function handleAuth(db, auth, fetchEmail = false) {
  const scope = ScopeSet.fromArray(auth.credentials.scope);
  if (!scope.contains(SUBSCRIPTIONS_MANAGEMENT_SCOPE)) {
    throw error.invalidScopes('Invalid authentication scope in token');
  }
  const { user: uid } = auth.credentials;
  let email;
  if (!fetchEmail) {
    ({ email } = auth.credentials);
  } else {
    const account = await db.account(uid);
    ({ email } = account.primaryEmail);
  }
  return { uid, email };
}

class DirectStripeRoutes {
  /**
   *
   * @param {*} log
   * @param {*} db
   * @param {*} config
   * @param {*} customs
   * @param {*} push
   * @param {*} mailer
   * @param {*} profile
   * @param {import('../payments/stripe')} payments
   */
  constructor(log, db, config, customs, push, mailer, profile, payments) {
    this.log = log;
    this.db = db;
    this.config = config;
    this.customs = customs;
    this.push = push;
    this.mailer = mailer;
    this.profile = profile;
    this.payments = payments;

    this.CLIENT_CAPABILITIES = Object.entries(
      config.subscriptions.clientCapabilities
    ).map(([clientId, capabilities]) => ({ clientId, capabilities }));
  }

  async getClients(request) {
    this.log.begin('subscriptions.getClients', request);
    return this.CLIENT_CAPABILITIES;
  }

  async createSubscription(request) {
    this.log.begin('subscriptions.createSubscription', request);

    const { uid, email } = await handleAuth(this.db, request.auth, true);

    await this.customs.check(request, email, 'createSubscription');

    const { planId, paymentToken, displayName } = request.payload;

    // Find the selected plan and get its product ID
    const selectedPlan = await this.payments.findPlanById(planId);
    const productId = selectedPlan.product_id;

    let customer = await this.payments.fetchCustomer(uid, email);
    if (!customer) {
      customer = await this.payments.stripe.customers.create({
        source: paymentToken,
        email,
        name: displayName,
        description: uid,
        metadata: { userid: uid },
      });
    } else if (paymentToken) {
      // Always update the source if we are given a paymentToken
      // Note that if the customer already exists and we were not
      // passed a paymentToken value, we will not update it and use
      // the default source.
      await this.payments.stripe.customers.update(customer.id, {
        source: paymentToken,
      });
    }

    // Check if the customer already has subscribed to this plan.
    // FIXME: Plan only exists for subscriptions with 1 plan.
    if (
      customer.subscriptions.data.find(
        sub => sub.plan.id === selectedPlan.plan_id
      )
    ) {
      throw error.subscriptionAlreadyExists();
    }

    // Create the subscription
    const subscription = await this.payments.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ plan: selectedPlan.plan_id }],
    });

    // Store the record in our local database
    await this.db.createAccountSubscription({
      uid,
      subscriptionId: subscription.id,
      productId,
      // Stripe create is in seconds, we use milliseconds
      createdAt: subscription.created * 1000,
    });

    const devices = await request.app.devices;
    await this.push.notifyProfileUpdated(uid, devices);
    this.log.notifyAttachedServices('profileDataChanged', request, {
      uid,
      email,
    });
    await this.profile.deleteCache(uid);

    const account = await this.db.account(uid);
    await this.mailer.sendDownloadSubscriptionEmail(account.emails, account, {
      acceptLanguage: account.locale,
      productId,
    });

    this.log.info('subscriptions.createSubscription.success', {
      uid,
      subscriptionId: subscription.id,
    });

    return { subscriptionId: subscription.id };
  }

  async deleteSubscription(request) {
    this.log.begin('subscriptions.deleteSubscription', request);

    const { uid, email } = await handleAuth(this.db, request.auth, true);

    await this.customs.check(request, email, 'deleteSubscription');

    const subscriptionId = request.params.subscriptionId;

    try {
      await this.db.getAccountSubscription(uid, subscriptionId);
    } catch (err) {
      if (err.statusCode === 404 && err.errno === 116) {
        throw error.unknownSubscription();
      }
    }

    await this.payments.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    try {
      await this.db.cancelAccountSubscription(uid, subscriptionId, Date.now());
    } catch (err) {
      if (err.statusCode === 404 && err.errno === 116) {
        throw error.subscriptionAlreadyCancelled();
      }
    }

    const devices = await request.app.devices;
    await this.push.notifyProfileUpdated(uid, devices);
    this.log.notifyAttachedServices('profileDataChanged', request, {
      uid,
      email,
    });
    await this.profile.deleteCache(uid);

    this.log.info('subscriptions.deleteSubscription.success', {
      uid,
      subscriptionId,
    });

    return { subscriptionId };
  }

  async updatePayment(request) {
    this.log.begin('subscriptions.updatePayment', request);

    const { uid, email } = await handleAuth(this.db, request.auth, true);
    await this.customs.check(request, email, 'updatePayment');

    const { paymentToken } = request.payload;

    const customer = await this.payments.fetchCustomer(uid, email);
    if (!customer) {
      const err = new Error(`No customer for email: ${email}`);
      throw error.backendServiceFailure('stripe', 'updatePayment', {}, err);
    }

    await this.payments.stripe.customers.update(customer.id, {
      source: paymentToken,
    });

    this.log.info('subscriptions.updatePayment.success', { uid });

    return {};
  }

  async reactivateSubscription(request) {
    this.log.begin('subscriptions.reactivateSubscription', request);

    const { uid, email } = await handleAuth(this.db, request.auth, true);

    await this.customs.check(request, email, 'reactivateSubscription');

    const { subscriptionId } = request.payload;

    try {
      await this.db.getAccountSubscription(uid, subscriptionId);
    } catch (err) {
      if (err.statusCode === 404 && err.errno === 116) {
        throw error.unknownSubscription();
      }
    }

    const subscription = await this.payments.stripe.subscriptions.update(
      subscriptionId,
      {
        cancel_at_period_end: false,
      }
    );
    if (!['active', 'trialing'].includes(subscription.status)) {
      const err = new Error(
        `Reactivated subscription (${subscriptionId}) is not active/trialing`
      );
      throw error.backendServiceFailure(
        'stripe',
        'reactivateSubscription',
        {},
        err
      );
    }

    await this.db.reactivateAccountSubscription(uid, subscriptionId);

    await this.push.notifyProfileUpdated(uid, await request.app.devices);
    this.log.notifyAttachedServices('profileDataChanged', request, {
      uid,
      email,
    });
    await this.profile.deleteCache(uid);

    this.log.info('subscriptions.reactivateSubscription.success', {
      uid,
      subscriptionId,
    });

    return {};
  }

  async updateSubscription(request) {
    this.log.begin('subscriptions.updateSubscription', request);

    const { uid, email } = await handleAuth(this.db, request.auth, true);

    await this.customs.check(request, email, 'updateSubscription');

    const { subscriptionId } = request.params;
    const { planId } = request.payload;

    let accountSub;

    try {
      accountSub = await this.db.getAccountSubscription(uid, subscriptionId);
    } catch (err) {
      if (err.statusCode === 404 && err.errno === 116) {
        throw error.unknownSubscription();
      }
    }
    const oldProductId = accountSub.productId;

    // Verify the plan is a valid upgrade for this subscription.
    await this.payments.verifyPlanUpgradeForSubscription(oldProductId, planId);

    // Upgrade the plan
    const changeResponse = await this.payments.changeSubscriptionPlan(
      subscriptionId,
      planId
    );
    const newProductId = changeResponse.plan.product;

    // Update the local db record for the new plan. We don't have a method to
    // change the product on file for a sub thus the delete/create here even
    // though its more work to catch both errors for a retry.
    try {
      await this.db.deleteAccountSubscription(uid, subscriptionId);
    } catch (err) {
      // It's ok if it was already cancelled or deleted.
      if (err.statusCode !== 404) {
        throw err;
      }
    }

    // This call needs to succeed for us to consider this a success.
    await this.db.createAccountSubscription({
      uid,
      subscriptionId,
      productId: newProductId,
      createdAt: Date.now(),
    });

    const devices = await request.app.devices;
    await this.push.notifyProfileUpdated(uid, devices);
    this.log.notifyAttachedServices('profileDataChanged', request, {
      uid,
      email,
    });
    await this.profile.deleteCache(uid);

    return { subscriptionId };
  }

  async listPlans(request) {
    this.log.begin('subscriptions.listPlans', request);
    await handleAuth(this.db, request.auth);
    const plans = await this.payments.allPlans();
    return plans;
  }

  async listActive(request) {
    this.log.begin('subscriptions.listActive', request);
    const { uid } = await handleAuth(this.db, request.auth, true);
    return this.db.fetchAccountSubscriptions(uid);
  }

  async getCustomer(request) {
    this.log.begin('subscriptions.getCustomer', request);
    const { uid, email } = await handleAuth(this.db, request.auth, true);
    const customer = await this.payments.fetchCustomer(uid, email, [
      'data.subscriptions.data.latest_invoice',
    ]);
    if (!customer) {
      throw error.unknownCustomer(uid);
    }
    let response = { subscriptions: [] };
    if (customer.sources && customer.sources.data.length > 0) {
      // Currently assume a single source, and we can only access these attributes
      // on cards.
      const src = customer.sources.data[0];
      if (src.object === 'card') {
        response = {
          ...response,
          payment_type: src.funding,
          last4: src.last4,
          exp_month: src.exp_month,
          exp_year: src.exp_year,
        };
      }
    }

    response.subscriptions = await this.payments.subscriptionsToResponse(
      customer.subscriptions
    );
    return response;
  }
}

const directRoutes = (log, db, config, customs, push, mailer, profile) => {
  const payments = new stripe(log, config);
  const directStripeRoutes = new DirectStripeRoutes(
    log,
    db,
    config,
    customs,
    push,
    mailer,
    profile,
    payments
  );

  // FIXME: All of these need to be wrapped in Stripe error handling
  // FIXME: Many of these stripe calls need retries with careful thought about
  //        overall request deadline. Stripe retries must include a idempotency_key.
  return [
    {
      method: 'GET',
      path: '/oauth/subscriptions/clients',
      options: {
        auth: {
          payload: false,
          strategy: 'subscriptionsSecret',
        },
        response: {
          schema: isA.array().items(
            isA.object().keys({
              clientId: isA.string(),
              capabilities: isA.array().items(isA.string()),
            })
          ),
        },
      },
      handler: request => directStripeRoutes.getClients(request),
    },
    {
      method: 'GET',
      path: '/oauth/subscriptions/plans',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        response: {
          schema: isA.array().items(validators.subscriptionsPlanValidator),
        },
      },
      handler: request => directStripeRoutes.listPlans(request),
    },
    {
      method: 'GET',
      path: '/oauth/subscriptions/active',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        response: {
          schema: isA.array().items(validators.activeSubscriptionValidator),
        },
      },
      handler: request => directStripeRoutes.listActive(request),
    },
    {
      method: 'POST',
      path: '/oauth/subscriptions/active',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        validate: {
          payload: {
            planId: validators.subscriptionsPlanId.required(),
            paymentToken: validators.subscriptionsPaymentToken.required(),
            displayName: isA.string().required(),
          },
        },
        response: {
          schema: isA.object().keys({
            subscriptionId: validators.subscriptionsSubscriptionId.required(),
          }),
        },
      },
      handler: request => directStripeRoutes.createSubscription(request),
    },
    {
      method: 'POST',
      path: '/oauth/subscriptions/updatePayment',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        validate: {
          payload: {
            paymentToken: validators.subscriptionsPaymentToken.required(),
          },
        },
      },
      handler: request => directStripeRoutes.updatePayment(request),
    },
    {
      method: 'GET',
      path: '/oauth/subscriptions/customer',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        response: {
          schema: validators.subscriptionsCustomerValidator,
        },
      },
      handler: request => directStripeRoutes.getCustomer(request),
    },
    {
      method: 'PUT',
      path: '/oauth/subscriptions/active/{subscriptionId}',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        validate: {
          params: {
            subscriptionId: validators.subscriptionsSubscriptionId.required(),
          },
          payload: {
            planId: validators.subscriptionsPlanId.required(),
          },
        },
      },
      handler: request => directStripeRoutes.updateSubscription(request),
    },
    {
      method: 'DELETE',
      path: '/oauth/subscriptions/active/{subscriptionId}',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        validate: {
          params: {
            subscriptionId: validators.subscriptionsSubscriptionId.required(),
          },
        },
      },
      handler: request => directStripeRoutes.deleteSubscription(request),
    },
    {
      method: 'POST',
      path: '/oauth/subscriptions/reactivate',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        validate: {
          payload: {
            subscriptionId: validators.subscriptionsSubscriptionId.required(),
          },
        },
      },
      handler: request => directStripeRoutes.reactivateSubscription(request),
    },
  ];
};

const createRoutes = (
  log,
  db,
  config,
  customs,
  push,
  mailer,
  subhub,
  profile
) => {
  // Skip routes if the subscriptions feature is not configured & enabled
  if (!config.subscriptions || !config.subscriptions.enabled) {
    return [];
  }

  if (config.subscriptions.stripeApiKey) {
    return directRoutes(log, db, config, customs, push, mailer, profile);
  }

  const CLIENT_CAPABILITIES = Object.entries(
    config.subscriptions.clientCapabilities
  ).map(([clientId, capabilities]) => ({ clientId, capabilities }));

  return [
    {
      method: 'GET',
      path: '/oauth/subscriptions/clients',
      options: {
        auth: {
          payload: false,
          strategy: 'subscriptionsSecret',
        },
        response: {
          schema: isA.array().items(
            isA.object().keys({
              clientId: isA.string(),
              capabilities: isA.array().items(isA.string()),
            })
          ),
        },
      },
      handler: async function(request) {
        log.begin('subscriptions.getClients', request);
        return CLIENT_CAPABILITIES;
      },
    },
    {
      method: 'GET',
      path: '/oauth/subscriptions/plans',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        response: {
          schema: isA.array().items(validators.subscriptionsPlanValidator),
        },
      },
      handler: async function(request) {
        log.begin('subscriptions.listPlans', request);
        await handleAuth(db, request.auth);
        const plans = await subhub.listPlans();

        // Delete any metadata keys prefixed by `capabilities:` before
        // sending response. We don't need to reveal those.
        // https://github.com/mozilla/fxa/issues/3273#issuecomment-552637420
        return plans.map(planIn => {
          // Try not to mutate the original in case we cache plans in memory.
          const plan = { ...planIn };
          for (const metadataKey of ['plan_metadata', 'product_metadata']) {
            if (plan[metadataKey]) {
              // Make a clone of the metadata object so we don't mutate the original.
              const metadata = { ...plan[metadataKey] };
              const capabilityKeys = Object.keys(metadata).filter(key =>
                key.startsWith('capabilities:')
              );
              for (const key of capabilityKeys) {
                delete metadata[key];
              }
              plan[metadataKey] = metadata;
            }
          }
          return plan;
        });
      },
    },
    {
      method: 'GET',
      path: '/oauth/subscriptions/active',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        response: {
          schema: isA.array().items(validators.activeSubscriptionValidator),
        },
      },
      handler: async function(request) {
        log.begin('subscriptions.listActive', request);
        const { uid } = await handleAuth(db, request.auth);
        return db.fetchAccountSubscriptions(uid);
      },
    },
    {
      method: 'POST',
      path: '/oauth/subscriptions/active',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        validate: {
          payload: {
            planId: validators.subscriptionsPlanId.required(),
            paymentToken: validators.subscriptionsPaymentToken.required(),
            displayName: isA.string().required(),
          },
        },
        response: {
          schema: isA.object().keys({
            subscriptionId: validators.subscriptionsSubscriptionId.required(),
          }),
        },
      },
      handler: async function(request) {
        log.begin('subscriptions.createSubscription', request);

        const { uid, email } = await handleAuth(db, request.auth, true);

        await customs.check(request, email, 'createSubscription');

        const { planId, paymentToken, displayName } = request.payload;

        // Find the selected plan and get its product ID
        const plans = await subhub.listPlans();
        const selectedPlan = plans.filter(p => p.plan_id === planId)[0];
        if (!selectedPlan) {
          throw error.unknownSubscriptionPlan(planId);
        }
        const productId = selectedPlan.product_id;
        const planMetadata = metadataFromPlan(selectedPlan);

        const paymentResult = await subhub.createSubscription(
          uid,
          paymentToken,
          planId,
          displayName,
          email
        );

        // FIXME: We're assuming the last subscription is newest, because
        // payment result doesn't actually report the newly-created subscription
        // https://github.com/mozilla/subhub/issues/56
        // https://github.com/mozilla/fxa/issues/1148
        const newSubscription = paymentResult.subscriptions.pop();
        const subscriptionId = newSubscription.subscription_id;

        await db.createAccountSubscription({
          uid,
          subscriptionId,
          productId,
          createdAt: Date.now(),
        });

        const devices = await request.app.devices;
        await push.notifyProfileUpdated(uid, devices);
        log.notifyAttachedServices('profileDataChanged', request, {
          uid,
          email,
        });
        await profile.deleteCache(uid);

        const account = await db.account(uid);
        await mailer.sendDownloadSubscriptionEmail(account.emails, account, {
          acceptLanguage: account.locale,
          productId,
          planId,
          productName: selectedPlan.product_name,
          planEmailIconURL: planMetadata.emailIconURL,
          planDownloadURL: planMetadata.downloadURL,
        });

        log.info('subscriptions.createSubscription.success', {
          uid,
          subscriptionId,
        });

        return { subscriptionId };
      },
    },
    {
      method: 'POST',
      path: '/oauth/subscriptions/updatePayment',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        validate: {
          payload: {
            paymentToken: validators.subscriptionsPaymentToken.required(),
          },
        },
      },
      handler: async function(request) {
        log.begin('subscriptions.updatePayment', request);

        const { uid, email } = await handleAuth(db, request.auth, true);
        await customs.check(request, email, 'updatePayment');

        const { paymentToken } = request.payload;

        await subhub.updateCustomer(uid, paymentToken);

        log.info('subscriptions.updatePayment.success', { uid });

        return {};
      },
    },
    {
      method: 'GET',
      path: '/oauth/subscriptions/customer',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        response: {
          schema: validators.subscriptionsCustomerValidator,
        },
      },
      handler: async function(request) {
        log.begin('subscriptions.getCustomer', request);
        const { uid } = await handleAuth(db, request.auth);
        return subhub.getCustomer(uid);
      },
    },
    {
      method: 'PUT',
      path: '/oauth/subscriptions/active/{subscriptionId}',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        validate: {
          params: {
            subscriptionId: validators.subscriptionsSubscriptionId.required(),
          },
          payload: {
            planId: validators.subscriptionsPlanId.required(),
          },
        },
      },
      handler: async function(request) {
        log.begin('subscriptions.updateSubscription', request);

        const { uid, email } = await handleAuth(db, request.auth, true);

        await customs.check(request, email, 'updateSubscription');

        const { subscriptionId } = request.params;
        const { planId } = request.payload;

        try {
          await db.getAccountSubscription(uid, subscriptionId);
        } catch (err) {
          if (err.statusCode === 404 && err.errno === 116) {
            throw error.unknownSubscription();
          }
        }

        // Find the selected plan and get its product ID
        const plans = await subhub.listPlans();
        const selectedPlan = plans.filter(p => p.plan_id === planId)[0];
        if (!selectedPlan) {
          throw error.unknownSubscriptionPlan(planId);
        }
        const newProductId = selectedPlan.product_id;
        try {
          await subhub.updateSubscription(uid, subscriptionId, planId);
        } catch (err) {
          if (err.errno !== 1003) {
            // Only allow already subscribed, as this call is being possibly repeated
            // to ensure the accountSubscriptions database is updated.
            throw err;
          }
        }

        // Update the local db record for the new plan. We don't have a method to
        // change the product on file for a sub thus the delete/create here even
        // though its more work to catch both errors for a retry.
        try {
          await db.deleteAccountSubscription(uid, subscriptionId);
        } catch (err) {
          // It's ok if it was already cancelled or deleted.
          if (err.statusCode !== 404) {
            throw err;
          }
        }

        // This call needs to succeed for us to consider this a success.
        await db.createAccountSubscription({
          uid,
          subscriptionId,
          productId: newProductId,
          createdAt: Date.now(),
        });

        const devices = await request.app.devices;
        await push.notifyProfileUpdated(uid, devices);
        log.notifyAttachedServices('profileDataChanged', request, {
          uid,
          email,
        });
        await profile.deleteCache(uid);

        return { subscriptionId };
      },
    },
    {
      method: 'DELETE',
      path: '/oauth/subscriptions/active/{subscriptionId}',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        validate: {
          params: {
            subscriptionId: validators.subscriptionsSubscriptionId.required(),
          },
        },
      },
      handler: async function(request) {
        log.begin('subscriptions.deleteSubscription', request);

        const { uid, email } = await handleAuth(db, request.auth, true);

        await customs.check(request, email, 'deleteSubscription');

        const subscriptionId = request.params.subscriptionId;

        try {
          await db.getAccountSubscription(uid, subscriptionId);
        } catch (err) {
          if (err.statusCode === 404 && err.errno === 116) {
            throw error.unknownSubscription();
          }
        }

        await subhub.cancelSubscription(uid, subscriptionId);

        try {
          await db.cancelAccountSubscription(uid, subscriptionId, Date.now());
        } catch (err) {
          if (err.statusCode === 404 && err.errno === 116) {
            throw error.subscriptionAlreadyCancelled();
          }
        }

        const devices = await request.app.devices;
        await push.notifyProfileUpdated(uid, devices);
        log.notifyAttachedServices('profileDataChanged', request, {
          uid,
          email,
        });
        await profile.deleteCache(uid);

        log.info('subscriptions.deleteSubscription.success', {
          uid,
          subscriptionId,
        });

        return { subscriptionId };
      },
    },
    {
      method: 'POST',
      path: '/oauth/subscriptions/reactivate',
      options: {
        auth: {
          payload: false,
          strategy: 'oauthToken',
        },
        validate: {
          payload: {
            subscriptionId: validators.subscriptionsSubscriptionId.required(),
          },
        },
      },
      handler: async function(request) {
        log.begin('subscriptions.reactivateSubscription', request);

        const { uid, email } = await handleAuth(db, request.auth, true);

        await customs.check(request, email, 'reactivateSubscription');

        const { subscriptionId } = request.payload;

        try {
          await db.getAccountSubscription(uid, subscriptionId);
        } catch (err) {
          if (err.statusCode === 404 && err.errno === 116) {
            throw error.unknownSubscription();
          }
        }

        await subhub.reactivateSubscription(uid, subscriptionId);
        await db.reactivateAccountSubscription(uid, subscriptionId);

        await push.notifyProfileUpdated(uid, await request.app.devices);
        log.notifyAttachedServices('profileDataChanged', request, {
          uid,
          email,
        });
        await profile.deleteCache(uid);

        log.info('subscriptions.reactivateSubscription.success', {
          uid,
          subscriptionId,
        });

        return {};
      },
    },
  ];
};

module.exports = createRoutes;
module.exports.DirectStripeRoutes = DirectStripeRoutes;
