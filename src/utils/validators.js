const DRINK_CATEGORIES = ["Trà Sữa", "Trà Trái Cây", "Cà Phê", "Đá Xay"];

function parseAddInput(commandText) {
  const input = String(commandText || "").trim();
  if (!input) {
    return null;
  }

  const quotedMatch = input.match(/^"(.+)"\s+(M|L)\s+(\d+)$/i);
  if (quotedMatch) {
    return {
      target: quotedMatch[1].trim(),
      targetType: "name",
      size: quotedMatch[2].toUpperCase(),
      quantity: Number.parseInt(quotedMatch[3], 10),
    };
  }

  const plainMatch = input.match(/^([^\s]+)\s+(M|L)\s+(\d+)$/i);
  if (!plainMatch) {
    return null;
  }

  const rawTarget = plainMatch[1].trim();
  const targetType = /^\d+$/.test(rawTarget) ? "index" : "code_or_name";

  return {
    target: rawTarget,
    targetType,
    size: plainMatch[2].toUpperCase(),
    quantity: Number.parseInt(plainMatch[3], 10),
  };
}

function normalizePhoneNumber(phoneRaw) {
  const compact = String(phoneRaw || "")
    .trim()
    .replace(/[\.\s-]/g, "")
    .replace(/^\+84/, "0")
    .replace(/^84/, "0");

  return compact;
}

function isValidVietnamPhone(phoneRaw) {
  const normalized = normalizePhoneNumber(phoneRaw);
  return /^0(3|5|7|8|9)\d{8}$/.test(normalized);
}

function normalizeDeliveryMethod(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (raw === "pickup" || raw === "pick up" || raw === "nhan tai quan" || raw === "nhận tại quán") {
    return "pickup";
  }

  if (raw === "delivery" || raw === "giao hang" || raw === "giao hàng") {
    return "delivery";
  }

  return null;
}

function validateAddCommand(commandText, menuItem) {
  const parsed = parseAddInput(commandText);

  if (!parsed) {
    return {
      isValid: false,
      error: "Sai cu phap. Dung: /add <item_code> <size> <quantity> hoac /add \"<item_name>\" <size> <quantity>.",
    };
  }

  const { target, targetType, size, quantity } = parsed;

  if (targetType === "index") {
    const itemIndex = Number.parseInt(target, 10);
    if (!Number.isInteger(itemIndex) || itemIndex <= 0) {
      return { isValid: false, error: "item_index phai la so nguyen duong." };
    }
  }

  if (!["M", "L"].includes(size)) {
    return { isValid: false, error: "size chi nhan M hoac L." };
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { isValid: false, error: "quantity phai la so nguyen duong." };
  }

  if (!menuItem && arguments.length >= 2) {
    return { isValid: false, error: "Mon khong ton tai. Dung /menu de xem lai." };
  }

  if (menuItem) {
    if (!menuItem.available) {
      return { isValid: false, error: "Mon nay hien dang tam het." };
    }

    if (!DRINK_CATEGORIES.includes(menuItem.category)) {
      return { isValid: false, error: "Mon topping khong the them bang /add dang do uong." };
    }

    const unitPrice = size === "L" ? menuItem.priceL : menuItem.priceM;
    if (!unitPrice || unitPrice <= 0) {
      return { isValid: false, error: "Khong tim thay gia hop le cho mon da chon." };
    }

    return {
      isValid: true,
      target,
      targetType,
      size,
      quantity,
      unitPrice,
    };
  }

  return {
    isValid: true,
    target,
    targetType,
    size,
    quantity,
  };
}

module.exports = {
  normalizePhoneNumber,
  isValidVietnamPhone,
  normalizeDeliveryMethod,
  parseAddInput,
  validateAddCommand,
};