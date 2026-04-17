function formatCurrencyVND(amount) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(Number(amount || 0));
}

function buildCartMessage(cart) {
  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
    return "Giỏ hàng đang trống. Dùng /menu để xem món rồi thêm bằng /add.";
  }

  let total = 0;
  const lines = cart.items.map((item, index) => {
    const quantity = Number(item.quantity || 0);
    const baseUnitPrice = Number(
      item.baseUnitPrice !== undefined && item.baseUnitPrice !== null ? item.baseUnitPrice : item.unitPrice || 0
    );
    const toppingDetails = Array.isArray(item.toppingDetails) ? item.toppingDetails : [];
    const toppingUnitTotal = toppingDetails.reduce((sum, top) => sum + Number(top.unitPrice || 0), 0);
    const effectiveUnitPrice =
      item.baseUnitPrice !== undefined && item.baseUnitPrice !== null
        ? baseUnitPrice + toppingUnitTotal
        : Number(item.unitPrice || 0);
    const lineTotal = effectiveUnitPrice * quantity;
    total += lineTotal;

    const detailLines = [
      `${index + 1}. ${item.name} (${item.size})`,
      `   Nước: ${formatCurrencyVND(baseUnitPrice)} x ${quantity} = ${formatCurrencyVND(baseUnitPrice * quantity)}`,
    ];

    if (toppingDetails.length > 0) {
      detailLines.push("   Topping:");
      for (const topping of toppingDetails) {
        const topUnitPrice = Number(topping.unitPrice || 0);
        detailLines.push(
          `   - ${topping.name}: ${formatCurrencyVND(topUnitPrice)} x ${quantity} = ${formatCurrencyVND(topUnitPrice * quantity)}`
        );
      }
    }

    if (item.note) {
      detailLines.push(`   Ghi chú: ${item.note}`);
    }

    detailLines.push(`   Tạm tính món: ${formatCurrencyVND(lineTotal)}`);

    return detailLines.join("\n");
  });

  return ["Giỏ hàng của bạn:", ...lines, "", `Tổng tiền: ${formatCurrencyVND(total)}`].join("\n");
}

function buildOrderSummaryMessage(orderInfo) {
  const lines = orderInfo.items.map((item, index) => {
    const lineTotal = item.unitPrice * item.quantity;
    return `${index + 1}. ${item.name} (${item.size}) x ${item.quantity} = ${formatCurrencyVND(lineTotal)}`;
  });

  const addressLine = orderInfo.deliveryMethod === "delivery" ? `Địa chỉ: ${orderInfo.address}` : "Địa chỉ: Không yêu cầu";
  const noteLine = orderInfo.note ? orderInfo.note : "Không có";

  return [
    "Xác nhận đơn hàng:",
    `Tên người nhận: ${orderInfo.customerName}`,
    `Số điện thoại: ${orderInfo.phone}`,
    `Hình thức nhận: ${orderInfo.deliveryMethod}`,
    addressLine,
    "",
    "Danh sách món:",
    ...lines,
    "",
    `Tổng tiền: ${formatCurrencyVND(orderInfo.totalAmount)}`,
    `Ghi chú: ${noteLine}`,
    "",
    "Nếu đúng, nhập /confirm để chốt đơn.",
    "Nếu muốn hủy, nhập /cancel.",
  ].join("\n");
}

module.exports = {
  formatCurrencyVND,
  buildCartMessage,
  buildOrderSummaryMessage,
};
