const axios = require("axios");
const crypto = require("crypto");

const PAYMENT_METHODS = {
  COD: "COD",
  QR: "QR",
};

let payOsOrderSeed = Number.parseInt(String(Date.now()).slice(-6), 10) || 1;

function isPayOsConfigured() {
  return Boolean(
    process.env.PAYOS_CLIENT_ID &&
      process.env.PAYOS_API_KEY &&
      process.env.PAYOS_CHECKSUM_KEY
  );
}

function getPaymentOptions(orderCode) {
  return [
    { code: PAYMENT_METHODS.COD, label: `1. COD (thanh toan khi nhan hang)` },
    { code: PAYMENT_METHODS.QR, label: `2. QR PayOS (thanh toan online)` },
  ];
}

function buildPayOsSignature(data, checksumKey) {
  const sortedKeys = Object.keys(data).sort();
  const signData = sortedKeys
    .map((key) => `${key}=${data[key]}`)
    .join("&");

  return crypto.createHmac("sha256", checksumKey).update(signData).digest("hex");
}

function buildPayOsCreateSignature(paymentRequest, checksumKey) {
  // PayOS create payment signature must follow this exact canonical order.
  const signData = [
    `amount=${paymentRequest.amount}`,
    `cancelUrl=${paymentRequest.cancelUrl}`,
    `description=${paymentRequest.description}`,
    `orderCode=${paymentRequest.orderCode}`,
    `returnUrl=${paymentRequest.returnUrl}`,
  ].join("&");

  return crypto.createHmac("sha256", checksumKey).update(signData).digest("hex");
}

function generatePayOsOrderCode(order) {
  // Keep it numeric and sufficiently unique to avoid duplicate orderCode on PayOS.
  payOsOrderSeed = (payOsOrderSeed + 1) % 900000;
  const timePart = Number.parseInt(String(Date.now()).slice(-6), 10) || 0;
  const seedPart = payOsOrderSeed;
  const chatPart = Number.parseInt(String(order.chatId || 0).replace(/\D/g, "").slice(-2), 10) || 0;
  const code = Number(`${String(timePart).padStart(6, "0")}${String((seedPart + chatPart) % 1000).padStart(3, "0")}`);
  return code;
}

function normalizePayOsError(error) {
  if (!error) {
    return "Khong xac dinh";
  }

  const status = error.response && error.response.status ? `HTTP ${error.response.status}` : "";
  const body = error.response && error.response.data ? error.response.data : null;
  const bodyCode = body && (body.code || body.errorCode || body.error) ? String(body.code || body.errorCode || body.error) : "";
  const bodyDesc = body && (body.desc || body.message || body.errorMessage) ? String(body.desc || body.message || body.errorMessage) : "";

  const parts = [status, bodyCode, bodyDesc, error.message].filter(Boolean);
  return parts.join(" | ");
}

async function createPayOsPaymentLink(order) {
  const checkoutBase = process.env.PAYOS_RETURN_URL || "https://example.com/payment-success";
  const cancelBase = process.env.PAYOS_CANCEL_URL || "https://example.com/payment-cancel";

  const paymentRequest = {
    orderCode: generatePayOsOrderCode(order),
    amount: order.totalAmount,
    description: `MilkTea ${order.orderCode}`.slice(0, 25),
    returnUrl: `${checkoutBase}?orderCode=${order.orderCode}`,
    cancelUrl: `${cancelBase}?orderCode=${order.orderCode}`,
    expiredAt: Math.floor(Date.now() / 1000) + 15 * 60,
  };

  const signature = buildPayOsCreateSignature(paymentRequest, process.env.PAYOS_CHECKSUM_KEY);

  let response;
  try {
    response = await axios.post(
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
  } catch (error) {
    throw new Error(`PayOS API loi: ${normalizePayOsError(error)}`);
  }

  const payload = response.data || {};
  const data = payload && payload.data && typeof payload.data === "object" ? payload.data : payload;
  const checkoutUrl = data.checkoutUrl || data.checkout_url || data.paymentUrl || data.payment_url || data.paymentLink || "";
  const qrCode = data.qrCode || data.qr_code || data.qrCodeText || data.qrCodeData || "";
  const paymentLinkId = data.paymentLinkId || data.payment_link_id || "";

  if (!checkoutUrl && !qrCode) {
    const failCode = payload.code || payload.error || "unknown";
    const failDesc = payload.desc || payload.message || "PayOS khong tra checkoutUrl/qrCode";
    throw new Error(`${failCode}: ${failDesc}`);
  }

  return {
    provider: "payos",
    providerOrderCode: paymentRequest.orderCode,
    paymentUrl: checkoutUrl,
    checkoutUrl,
    qrCode,
    paymentLinkId,
    status: "CREATED",
    expiredAt: paymentRequest.expiredAt,
  };
}

async function createPaymentLink(order) {
  if (!isPayOsConfigured()) {
    throw new Error("PayOS chua duoc cau hinh day duoc tren server.");
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
    provider: "payos",
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
