'use strict';
// @ts-nocheck

const { expect } = require('chai');
const { classifyGlsDeliveryStatus } = require('./lib/glsStatus');

const deliveryStatus = {
  ERROR: -1,
  UNKNOWN: 5,
  REGISTERED: 10,
  IN_PREPARATION: 20,
  IN_TRANSIT: 30,
  OUT_FOR_DELIVERY: 40,
  DELIVERED: 1,
};

describe('GLS delivery status', () => {
  it('classifies the GLS DELIVERY_TODAY enum as out for delivery', () => {
    const parcel = {
      deliveredAt: null,
      latestStatusText: 'Das Paket wird voraussichtlich im Laufe des Tages zugestellt.',
      estimate: {
        deliveryStatus: 'DELIVERY_TODAY',
        updatedDeliveryStatus: 'DELIVERY_TODAY',
      },
    };

    expect(classifyGlsDeliveryStatus(parcel, deliveryStatus)).to.equal(deliveryStatus.OUT_FOR_DELIVERY);
  });

  it('classifies the GLS out-for-delivery wording when no estimate is available', () => {
    const parcel = {
      deliveredAt: null,
      latestStatusText: 'Das Paket wird voraussichtlich im Laufe des Tages zugestellt.',
      estimate: null,
    };

    expect(classifyGlsDeliveryStatus(parcel, deliveryStatus)).to.equal(deliveryStatus.OUT_FOR_DELIVERY);
  });

  it('keeps a delivered GLS parcel classified as delivered', () => {
    const parcel = {
      deliveredAt: '2026-07-14 13:11:58',
      latestStatusText: 'Das Paket wurde erfolgreich zugestellt.',
      estimate: {
        deliveryStatus: 'DELIVERED_TO_RECIPIENT',
        updatedDeliveryStatus: 'DELIVERED_TO_RECIPIENT',
      },
    };

    expect(classifyGlsDeliveryStatus(parcel, deliveryStatus)).to.equal(deliveryStatus.DELIVERED);
  });

  it('prefers a definitive delivery timestamp over a stale estimate', () => {
    const parcel = {
      deliveredAt: '2026-07-14 13:11:58',
      latestStatusText: 'Das Paket wurde erfolgreich zugestellt.',
      estimate: {
        deliveryStatus: 'DELIVERY_TODAY',
        updatedDeliveryStatus: 'DELIVERY_TODAY',
      },
    };

    expect(classifyGlsDeliveryStatus(parcel, deliveryStatus)).to.equal(deliveryStatus.DELIVERED);
  });
});
