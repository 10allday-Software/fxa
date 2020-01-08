/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const error = require('../error');
const subhub = require('../subhub/client');

const stripe = require('stripe');

/** @typedef {import('stripe').customers.ICustomer} Customer */
/** @typedef {import('stripe').products.IProduct} Product */
/** @typedef {import('stripe').plans.IPlan} Plan */
/** @typedef {import('stripe').subscriptions.ISubscription} Subscription */
/** @typedef {import('stripe').customers.ICustomerSubscriptions} Subscriptions */

/**
 * @typedef AbbrevProduct
 * @property {string} product_id
 * @property {string} product_name
 * @property {Product['metadata']} product_metadata
 */

/**
 * @typedef AbbrevPlan
 * @property {string} plan_id
 * @property {string} plan_name
 * @property {Product['metadata']} plan_metadata
 * @property {string} product_id
 * @property {string} product_name
 * @property {Product['metadata']} product_metadata
 * @property {Plan['interval']} interval
 * @property {Plan['amount']} amount
 * @property {Plan['currency']} currency
 */

/**
 * Get a cached result at a cache key and regenerated it with `refreshFunction`
 * if its expired.
 *
 * @template T
 * @param {*} redis
 * @param {string} cacheKey
 * @param {number} cacheTtl
 * @param {() => Promise<T>} refreshFunction
 * @returns {Promise<T>} possibly cached result
 */
async function cachedResult(log, redis, cacheKey, cacheTtl, refreshFunction) {
  if (cacheTtl) {
    try {
      const json = await redis.get(cacheKey);
      if (json) {
        return JSON.parse(json);
      }
    } catch (err) {
      log.error(
        `subhub.cachedResult.${refreshFunction.name}.getCachedResponse.failed`,
        { err }
      );
    }
  }

  const result = await refreshFunction();
  if (cacheTtl) {
    redis
      .set(cacheKey, JSON.stringify(result), 'EX', cacheTtl)
      .catch(err =>
        log.error(
          `subhub.cachedResult.${refreshFunction.name}.cacheResponse.failed`,
          { err }
        )
      );
  }
  return result;
}

class StripeHelper {
  /**
   * Create a Stripe Helper with built-in caching.
   *
   * @param {object} log
   * @param {object} config
   */
  constructor(log, config) {
    this.log = log;
    this.cacheTtlSeconds = config.subhub.plansCacheTtlSeconds;
    const redis =
      this.cacheTtlSeconds &&
      require('../redis')(
        {
          ...config.redis,
          ...config.redis.subhub,
        },
        log
      );
    this.plansCacheIsEnabled = this.cacheTtlSeconds && redis;

    this.stripe = new stripe(config.subscriptions.stripeApiKey, {
      maxNetworkRetries: 3,
    });
    this.redis = redis;
  }

  /**
   * Fetch all product data and cache it if Redis is enabled.
   *
   * Use `allProducts` below to use the cached-enhanced version.
   *
   * @returns {Promise<AbbrevProduct[]>} All the products.
   */
  async fetchAllProducts() {
    const products = [];
    for await (const product of this.stripe.products.list()) {
      products.push({
        product_id: product.id,
        product_name: product.name,
        product_metadata: product.metadata,
      });
    }
    return products;
  }

  /**
   * Fetches all products from stripe and returns them.
   *
   * Uses Redis caching if configured.
   *
   * @returns {Promise<AbbrevProduct[]>} All the products.
   */
  async allProducts() {
    return cachedResult(
      this.log,
      this.redis,
      'listProducts',
      this.cacheTtlSeconds,
      () => this.fetchAllProducts()
    );
  }

  /**
   * Fetch a customer for the record from Stripe based on email.
   *
   * @param {string} uid Firefox Account Uid
   * @param {string} email Firefox Account Email
   * @param {string[]} [expand] Additional fields to expand in the
   *                           Stripe call.
   * @returns {Promise<Customer|void>} Customer if exists in the system.
   */
  async fetchCustomer(uid, email, expand) {
    const customerResponse = await this.stripe.customers
      .list({ email, expand })
      .autoPagingToArray({ limit: 20 });
    if (customerResponse.length === 0) {
      return;
    }
    const customer = customerResponse[0];

    if (customer.metadata.userid !== uid) {
      // Duplicate email with non-match uid
      const err = new Error(
        `Customer for email: ${email} in Stripe has mismatched uid`
      );
      throw error.backendServiceFailure('stripe', 'fetchCustomer', {}, err);
    }
    return customer;
  }

  /**
   * Fetches all plans from stripe and returns them.
   *
   * Use `allPlans` below to use the cached-enhanced version.
   *
   * @returns {Promise<AbbrevPlan[]>} All the plans.
   */
  async fetchAllPlans() {
    const plans = [];
    for await (const item of this.stripe.plans.list({
      active: true,
      expand: ['data.product'],
    })) {
      // FIXME: Should probably error here if we can't set a product id/name.
      let product_id, product_name, product_metadata;
      if (item.product && typeof item.product !== 'string') {
        product_id = item.product.id;
        product_name = item.product.name;
        product_metadata = item.product.metadata;
      }

      plans.push({
        plan_id: item.id,
        plan_name: item.nickname,
        plan_metadata: item.metadata,
        product_id,
        product_name,
        product_metadata,
        interval: item.interval,
        amount: item.amount,
        currency: item.currency,
      });
    }
    return plans;
  }

  /**
   * Fetches all plans from stripe and returns them.
   *
   * Uses Redis caching if configured.
   *
   * @returns {Promise<AbbrevPlan[]>} All the plans.
   */
  async allPlans() {
    return cachedResult(
      this.log,
      this.redis,
      'listPlans',
      this.cacheTtlSeconds,
      () => this.fetchAllPlans()
    );
  }

  /**
   * Find a plan by id or error if its not a valid planId.
   *
   * @param {string} planId
   * @returns {Promise<AbbrevPlan>}
   */
  async findPlanById(planId) {
    const plans = await this.allPlans();
    const selectedPlan = plans.find(p => p.plan_id === planId);
    if (!selectedPlan) {
      throw error.unknownSubscriptionPlan(planId);
    }
    return selectedPlan;
  }

  /**
   * Verify that the `planId` is a valid upgrade for this `productId`.
   *
   * Throws an error if its an invalid upgrade.
   *
   * @param {string} productId
   * @param {string} planId
   * @returns {Promise<void>}
   */
  async verifyPlanUpgradeForSubscription(productId, planId) {
    const allPlans = await this.allPlans();
    const currentPlan = allPlans
      .filter(plan => plan.product_id === productId)
      .shift();

    const newPlan = allPlans.filter(plan => plan.plan_id === planId).shift();
    if (!newPlan || !currentPlan) {
      throw error.unknownSubscriptionPlan();
    }
    if (
      !subhub.validateProductUpgrade(
        currentPlan.product_metadata,
        newPlan.product_metadata
      )
    ) {
      throw error.invalidPlanUpgrade();
    }
  }

  /**
   * Change a subscription to the new plan.
   *
   * Note that this call does not verify its a valid upgrade, the
   * `verifyPlanUpgradeForSubscription` should be done first to
   * validate this is an appropraite change for tier use.
   *
   * @param {Subscription['id']} subscriptionId
   * @param {Plan['id']} planId
   */
  async changeSubscriptionPlan(subscriptionId, planId) {
    const subscription = await this.stripe.subscriptions.retrieve(
      subscriptionId
    );
    if (subscription.items.data[0].plan.id === planId) {
      throw error.subscriptionAlreadyChanged();
    }
    return await this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
      items: [
        {
          id: subscription.items.data[0].id,
          plan: planId,
        },
      ],
    });
  }

  /**
   * Formats Stripe subscriptions for a customer into an appropriate response.
   *
   * @param {Subscriptions} subscriptions Subscriptions to finesse
   * @returns {Promise<object[]>} Formatted list of subscriptions.
   */
  async subscriptionsToResponse(subscriptions) {
    const subs = [];
    for (const sub of subscriptions.data) {
      let failure_code, failure_message;
      // If this is a charge-automatically payment that is incomplete, attempt
      // to get details of why it failed. The caller should expand the last_invoice
      // calls by passing ['data.subscriptions.data.latest_invoice'] to `fetchCustomer`
      // as the `expand` argument or this will not fetch the failure code/message.
      if (
        sub.status === 'incomplete' &&
        typeof sub.latest_invoice !== 'string' &&
        sub.collection_method === 'charge_automatically' &&
        typeof sub.latest_invoice.charge === 'string'
      ) {
        const charge = await this.stripe.charges.retrieve(
          sub.latest_invoice.charge
        );
        failure_code = charge.failure_code;
        failure_message = charge.failure_message;
      }
      // FIXME: Note that the plan is only set if the subscription contains a single
      //        plan. Multiple product support will require changes here to fetch all
      //        plans for this subscription.
      subs.push({
        current_period_end: sub.current_period_end,
        current_period_start: sub.current_period_start,
        cancel_at_period_end: sub.cancel_at_period_end,
        end_at: sub.ended_at,
        plan_name: sub.plan.nickname,
        plan_id: sub.plan.id,
        status: sub.status,
        subscription_id: sub.id,
        failure_code,
        failure_message,
      });
    }
    return subs;
  }
}

module.exports = StripeHelper;
