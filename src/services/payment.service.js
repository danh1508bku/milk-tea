const axios = require("axios");
const crypto = require("crypto");

const PAYMENT_METHODS = {
  COD: "COD",
  QR: "QR",
};

function isPayOsConfigured() {
  return Boolean(
    process.env.PAYOS_CLIENT_ID &&
      process.env.PAYOS_API_KEY &&
      process.env.PAYOS_CHECKSUM_KEY
  );
}

function getPaymentOptions(orderCode) {
  return [
    { code: PAYMENT_METHODS.COD, label: `1. COD (/cod ${orderCode})` },
    { code: PAYMENT_METHODS.QR, label: `2. QR Payment (/qr ${orderCode})` },
  ];
}

function createMockPaymentLink(order) {
  return {
    provider: "mock",
    paymentUrl: `https://pay.mock/${order.orderCode}`,
    checkoutUrl: `https://pay.mock/${order.orderCode}`,
    qrCode: `MOCK_QR_${order.orderCode}`,
    status: "CREATED",
    expiredAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

function buildPayOsSignature(data, checksumKey) {
  const sortedKeys = Object.keys(data).sort();
  const signData = sortedKeys
    .map((key) => `${key}=${data[key]}`)
    .join("&");

  return crypto.createHmac("sha256", checksumKey).update(signData).digest("hex");
}

async function createPayOsPaymentLink(order) {
  const checkoutBase = process.env.PAYOS_RETURN_URL || "https://example.com/payment-success";
  const cancelBase = process.env.PAYOS_CANCEL_URL || "https://example.com/payment-cancel";

  const paymentRequest = {
    orderCode: Number(String(order.orderCode).replace(/\D/g, "").slice(-9)) || Date.now(),
    amount: order.totalAmount,
    description: `MilkTea ${order.orderCode}`.slice(0, 25),
    returnUrl: `${checkoutBase}?orderCode=${order.orderCode}`,
    cancelUrl: `${cancelBase}?orderCode=${order.orderCode}`,
    expiredAt: Math.floor(Date.now() / 1000) + 15 * 60,
  };

  const signature = buildPayOsSignature(paymentRequest, process.env.PAYOS_CHECKSUM_KEY);

  const response = await axios.post(
    "https://api-merchant.payos.vn/v2/payment-requests",
    {
      ...paymentRequest,
      signature,
    },
    {
      headers: {
        "x-client-id": process.env.PAYOS_CLIENT_ID,
        "x-api-key": process.env.PAYOS_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );

  const data = response.data && response.data.data ? response.data.data : {};
  return {
    provider: "payos",
    paymentUrl: data.checkoutUrl,
    checkoutUrl: data.checkoutUrl,
    qrCode: data.qrCode,
    paymentLinkId: data.paymentLinkId,
    status: "CREATED",
    expiredAt: paymentRequest.expiredAt,
  };
}

async function createPaymentLink(order) {
  if (!isPayOsConfigured()) {
    return createMockPaymentLink(order);
  }

  return createPayOsPaymentLink(order);
}

function choosePaymentMethod(orderCode, method) {
  const normalized = String(method || "").trim().toUpperCase();
  if (![PAYMENT_METHODS.COD, PAYMENT_METHODS.QR].includes(normalized)) {
    return {
      ok: false,
      error: "Phuong thuc thanh toan khong hop le.",
    };
  }

  return {
    ok: true,
    paymentMethod: normalized,
  };
}

function verifyPayOsWebhook(payload, signature) {
  if (!isPayOsConfigured()) {
    return true;
  }

  if (!signature || !payload || !payload.data) {
    return false;
  }

  const expected = buildPayOsSignature(payload.data, process.env.PAYOS_CHECKSUM_KEY);
  return expected === signature;
}

function handlePaymentWebhook(payload, signature) {
  const isValid = verifyPayOsWebhook(payload, signature);
  if (!isValid) {
    return {
      success: false,
      error: "Invalid PayOS signature",
    };
  }

  const data = payload && payload.data ? payload.data : {};
  return {
    success: true,
    provider: isPayOsConfigured() ? "payos" : "mock",
    orderCode: data.description ? String(data.description).split(" ").pop() : payload.orderCode || null,
    amount: data.amount || 0,
    status: data.code === "00" ? "PAID" : "FAILED",
    raw: payload,
    receivedAt: new Date().toISOString(),
  };
}

module.exports = {
  PAYMENT_METHODS,
  isPayOsConfigured,
  createPaymentLink,
  getPaymentOptions,
  choosePaymentMethod,
  handlePaymentWebhook,
};
