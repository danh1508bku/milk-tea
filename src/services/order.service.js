const orders = [];
let orderCounter = 1;

const ORDER_STATUS = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  PAID: "PAID",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
};

const PAYMENT_STATUS = {
  UNPAID: "UNPAID",
  PAID: "PAID",
  FAILED: "FAILED",
};

function nowIso() {
  return new Date().toISOString();
}

function generateOrderCode() {
  const code = `ORD${String(orderCounter).padStart(4, "0")}`;
  orderCounter += 1;
  return code;
}

async function initialize() {
  return {
    mode: "in-memory",
  };
}

async function createOrder(payload) {
  const order = {
    orderCode: generateOrderCode(),
    chatId: payload.chatId,
    customerName: payload.customerName,
    phone: payload.phone,
    deliveryMethod: payload.deliveryMethod,
    address: payload.address || "",
    note: payload.note || "",
    items: Array.isArray(payload.items) ? payload.items : [],
    totalAmount: payload.totalAmount,
    status: ORDER_STATUS.CONFIRMED,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMethod: payload.paymentMethod || null,
    payment: payload.payment || null,
    deliveredAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  orders.push(order);
  return order;
}

async function listOrders() {
  return [...orders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function getOrderByCode(orderCode) {
  const normalizedCode = String(orderCode || "").toUpperCase();
  return orders.find((order) => order.orderCode === normalizedCode) || null;
}

async function updateOrderPayment(orderCode, paymentStatus) {
  const order = await getOrderByCode(orderCode);
  if (!order) {
    return null;
  }

  order.paymentStatus = paymentStatus;
  if (paymentStatus === PAYMENT_STATUS.PAID) {
    order.status = ORDER_STATUS.PAID;
  }

  order.updatedAt = nowIso();
  return order;
}

async function setPaymentMethod(orderCode, paymentMethod) {
  const order = await getOrderByCode(orderCode);
  if (!order) {
    return null;
  }

  order.paymentMethod = paymentMethod;
  order.updatedAt = nowIso();
  return order;
}

async function saveOrderPayment(orderCode, paymentPayload) {
  const order = await getOrderByCode(orderCode);
  if (!order) {
    return null;
  }

  order.payment = paymentPayload || null;
  order.updatedAt = nowIso();
  return order;
}

async function markOrderCancelled(orderCode) {
  const order = await getOrderByCode(orderCode);
  if (!order) {
    return null;
  }

  order.status = ORDER_STATUS.CANCELLED;
  order.updatedAt = nowIso();
  return order;
}

async function markOrderDelivered(orderCode) {
  const order = await getOrderByCode(orderCode);
  if (!order) {
    return null;
  }

  order.status = ORDER_STATUS.DELIVERED;
  order.deliveredAt = nowIso();
  order.updatedAt = nowIso();
  return order;
}

module.exports = {
  ORDER_STATUS,
  PAYMENT_STATUS,
  initialize,
  createOrder,
  listOrders,
  getOrderByCode,
  updateOrderPayment,
  setPaymentMethod,
  saveOrderPayment,
  markOrderCancelled,
  markOrderDelivered,
};
