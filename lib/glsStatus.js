'use strict';

const GLS_STATUS_MAP = {
  PREADVICE: 'REGISTERED',
  ESTIMATE_AVAILABLE_SOON: 'IN_TRANSIT',
  DELIVERY_IN_TWO_OR_MORE_DAYS__ESTIMATE_PENDING: 'IN_TRANSIT',
  DELIVERY_IN_TWO_OR_MORE_DAYS__ESTIMATE_CONFIRMED: 'IN_TRANSIT',
  DELIVERY_IN_ONE_DAY: 'IN_TRANSIT',
  DELIVERY_TODAY: 'OUT_FOR_DELIVERY',
  DELIVERED_TO_RECIPIENT: 'DELIVERED',
  DELIVERED_TO_NEIGHBOR: 'DELIVERED',
  DELIVERED_TO_LETTERBOX: 'DELIVERED',
  DELIVERED_TO_DROPOFF: 'DELIVERED',
  DELIVERED_TO_PARCEL_LOCKER: 'DELIVERED',
  DELIVERED_TO_PARCEL_SHOP: 'DELIVERED',
  DELIVERY_FINALIZED: 'DELIVERED',
  PICKED_UP_FROM_LOCKER: 'DELIVERED',
  PICKED_UP_FROM_SHOP: 'DELIVERED',
  DELIVERY_UNSUCCESSFUL: 'ERROR',
  DELIVERY_DECLINED_BY_CONSIGNEE: 'ERROR',
  DELIVERY_CANCELLED: 'ERROR',
  COULD_NOT_BE_DELIVERED_TO_OCCUPIED_PARCEL_LOCKER: 'ERROR',
  DELIVERY_SENT_BACK_TO_WAREHOUSE: 'ERROR',
  RETURNED_TO_DEPOT_FOR_PICKUP: 'IN_TRANSIT',
  RETURNED_TO_PARCEL_SHOP_FOR_PICKUP: 'IN_TRANSIT',
};

/**
 * Maps a parcel from the current GLS backend to the adapter's collective
 * delivery status. Returns undefined for unrecognized text so the adapter's
 * provider-independent fallback can still inspect it.
 *
 * @param {Record<string, any>} sendung GLS tracking response
 * @param {Record<string, number>} deliveryStatus Adapter status enum
 * @returns {number | undefined}
 */
function classifyGlsDeliveryStatus(sendung, deliveryStatus) {
  // deliveredAt is a definitive terminal signal and must win even if the
  // estimate enum has not caught up yet.
  if (sendung.deliveredAt) {
    return deliveryStatus.DELIVERED;
  }

  const estimate = sendung.estimate || {};
  const enumStatus = estimate.updatedDeliveryStatus || estimate.deliveryStatus;
  const mappedStatus = GLS_STATUS_MAP[enumStatus];
  if (mappedStatus && deliveryStatus[mappedStatus] !== undefined) {
    return deliveryStatus[mappedStatus];
  }

  if (sendung.hasDeliveryAttemptFailed) {
    return deliveryStatus.ERROR;
  }

  const text = String(sendung.latestStatusText || '').toLowerCase();
  if (!text) {
    return deliveryStatus.UNKNOWN;
  }

  // Check this before "zugestellt": the GLS future-tense wording contains
  // that word even though the parcel is only out for delivery.
  if (
    text.includes('in der zustellung') ||
    text.includes('zustellfahrzeug') ||
    text.includes('im laufe des tages') ||
    text.includes('out for delivery')
  ) {
    return deliveryStatus.OUT_FOR_DELIVERY;
  }
  if (text.includes('zugestellt') || text.includes('delivered')) {
    return deliveryStatus.DELIVERED;
  }
  if (
    text.includes('paketzentrum') ||
    text.includes('umschlagbetrieb') ||
    text.includes('transport') ||
    text.includes('unterwegs') ||
    text.includes('eingegangen') ||
    text.includes('eingetroffen') ||
    text.includes('übernommen')
  ) {
    return deliveryStatus.IN_TRANSIT;
  }
  if (text.includes('vorangemeldet') || text.includes('label') || text.includes('avisiert') || text.includes('erfasst')) {
    return deliveryStatus.REGISTERED;
  }

  return undefined;
}

module.exports = { classifyGlsDeliveryStatus };
