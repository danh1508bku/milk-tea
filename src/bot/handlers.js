const {
  buildCartMessage,
  buildOrderSummaryMessage,
  formatCurrencyVND,
} = require("../utils/formatter");
const {
  validateAddCommand,
  normalizePhoneNumber,
  isValidVietnamPhone,
  normalizeDeliveryMethod,
} = require("../utils/validators");

function getMainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["Xem menu", "Xem giỏ hàng"],
        ["Checkout", "/help"],
      ],
      resize_keyboard: true,
    },
  };
}

function getDeliveryMethodKeyboard() {
  return {
    reply_markup: {
      keyboard: [["Pickup", "Delivery"]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
}

function getAiPostActionKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["Xem giỏ hàng", "Checkout"],
        ["Chọn món khác"],
      ],
      resize_keyboard: true,
    },
  };
}

function getAiChooseSizeKeyboard() {
  return {
    reply_markup: {
      keyboard: [["Size M", "Size L"], ["Hủy chọn món"]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
}

function getAiChooseQuantityKeyboard() {
  return {
    reply_markup: {
      keyboard: [["1", "2", "3", "Số khác"], ["Hủy chọn món"]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
}

function getAiToppingDecisionKeyboard() {
  return {
    reply_markup: {
      keyboard: [["Thêm topping", "Bỏ qua topping"], ["Hủy chọn món"]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
}

function buildAiNextStepHint() {
  return [
    "",
    "Tiếp theo bạn có thể:",
    "- Xem giỏ hàng",
    "- Checkout",
    "- Chọn món khác",
  ];
}

function buildCartAdjustKeyboard(cart) {
  const items = cart && Array.isArray(cart.items) ? cart.items : [];
  if (items.length === 0) {
    return null;
  }

  const rows = items.map((item, index) => {
    const line = index + 1;
    return [
      { text: `➖ ${line}`, callback_data: `ct:dec:${line}` },
      { text: `${line}. ${item.name} x${item.quantity || 0}`, callback_data: `ct:noop:${line}` },
      { text: `➕ ${line}`, callback_data: `ct:inc:${line}` },
    ];
  });

  rows.push([{ text: "Làm mới giỏ", callback_data: "ct:refresh" }]);

  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

function getAdminKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["Đơn hàng", "Menu quản lý"],
        ["Thêm món mới", "Tìm đơn hàng"],
        ["Hướng dẫn admin"],
      ],
      resize_keyboard: true,
    },
  };
}

function buildAdminHomeInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Đơn hàng", callback_data: "ad:orders:list:0" },
          { text: "Menu", callback_data: "ad:menu:list:0" },
        ],
        [
          { text: "Thêm món", callback_data: "ad:menu:add:start" },
          { text: "Tìm đơn", callback_data: "ad:orders:find:start" },
        ],
      ],
    },
  };
}

function splitPipeArgs(raw) {
  return String(raw || "")
    .split("|")
    .map((part) => part.trim());
}

function parseMenuAddArgs(raw) {
  const parts = splitPipeArgs(raw);
  if (parts.length < 5) {
    return { ok: false, error: "Sai cu phap. Dung: /menuadd <item_id>|<ten>|<category>|<price_m>|<price_l>|<available>|<description>" };
  }

  const [itemId, name, category, priceM, priceL, available = "true", ...descriptionParts] = parts;
  return {
    ok: true,
    payload: {
      itemId,
      name,
      category,
      priceM,
      priceL,
      available,
      description: descriptionParts.join(" | "),
    },
  };
}

function parseMenuEditArgs(raw) {
  const parts = splitPipeArgs(raw);
  if (parts.length < 2) {
    return { ok: false, error: "Sai cu phap. Dung: /menuedit <item_id>|field=value|field=value" };
  }

  const itemId = parts[0];
  const updates = {};
  const fieldMap = {
    name: "name",
    category: "category",
    description: "description",
    price_m: "priceM",
    price_l: "priceL",
    available: "available",
  };

  for (const pair of parts.slice(1)) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0) {
      return { ok: false, error: `Cap nhat khong hop le: ${pair}` };
    }

    const rawField = pair.slice(0, eqIndex).trim().toLowerCase();
    const rawValue = pair.slice(eqIndex + 1).trim();
    const mapped = fieldMap[rawField];
    if (!mapped) {
      return { ok: false, error: `Field khong duoc ho tro: ${rawField}` };
    }

    updates[mapped] = rawValue;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "Khong co field nao de cap nhat." };
  }

  return { ok: true, itemId, updates };
}

function buildPaymentMethodInlineKeyboard(orderCode) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Thanh toán COD", callback_data: `pm:cod:${orderCode}` },
          { text: "Thanh toán QR PayOS", callback_data: `pm:qr:${orderCode}` },
        ],
      ],
    },
  };
}

function setupBotHandlers(bot, services) {
  const {
    menuService,
    cartService,
    orderService,
    sessionService,
    paymentService,
    llmService,
    adminChatId,
  } = services;

  const { STATES, MODES } = sessionService;

  function logEvent(event, data) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${event}]`, data);
  }

  function buildPaymentLinkMessage(orderCode, paymentLink) {
    const lines = [`Link thanh toan cho don ${orderCode}:`];
    const checkoutUrl = String(paymentLink && (paymentLink.paymentUrl || paymentLink.checkoutUrl) || "").trim();
    const qrCode = String(paymentLink && paymentLink.qrCode || "").trim();

    if (checkoutUrl) {
      lines.push(checkoutUrl);
    }

    if (qrCode) {
      lines.push("\nMa QR:");
      lines.push(qrCode.length > 700 ? `${qrCode.slice(0, 700)}...` : qrCode);
    }

    if (!checkoutUrl && !qrCode) {
      lines.push("PayOS khong tra ve link/QR hop le. Vui long thu lai sau it phut.");
    }

    lines.push("\nSau khi thanh toan xong, he thong se tu dong cap nhat trang thai don.");
    return lines.join("\n");
  }

  function logCommand(chatId, command, payload = "") {
    logEvent("COMMAND", { chatId, command, payload });
  }

  function getChatMode(chatId) {
    return sessionService.getMode(chatId);
  }

  function isAdminChat(chatId) {
    if (!adminChatId) {
      return true;
    }

    return String(chatId) === String(adminChatId);
  }

  function maskPhone(phone) {
    const value = String(phone || "");
    if (value.length < 6) {
      return value;
    }

    return `${value.slice(0, 3)}xxx${value.slice(-3)}`;
  }

  function canManageOrder(chatId, order) {
    return String(order.chatId) === String(chatId) || isAdminChat(chatId);
  }

  function getAdminFlow(chatId) {
    const session = sessionService.getSession(chatId);
    return session && session.data ? session.data.adminFlow || null : null;
  }

  function saveAdminFlow(chatId, partial) {
    const current = getAdminFlow(chatId) || {};
    sessionService.mergeData(chatId, {
      adminFlow: {
        ...current,
        ...partial,
      },
    });
  }

  function clearAdminFlow(chatId) {
    sessionService.mergeData(chatId, { adminFlow: null });
  }

  function getKeyboardByRole(chatId) {
    return isAdminChat(chatId) ? getAdminKeyboard() : getMainKeyboard();
  }

  async function denyBuyerFlowForAdmin(chatId) {
    if (!isAdminChat(chatId)) {
      return false;
    }

    await bot.sendMessage(
      chatId,
      "Tai khoan admin chi dung chuc nang quan tri. Dung /help de xem lenh quan tri.",
      getAdminKeyboard()
    );
    return true;
  }

  function buildAdminOrdersKeyboard(orders, page = 0) {
    const pageSize = 6;
    const safePage = Math.max(0, page);
    const start = safePage * pageSize;
    const current = orders.slice(start, start + pageSize);
    const rows = current.map((order) => ([{
      text: `${order.orderCode} | ${order.status} | ${order.totalAmount}đ`,
      callback_data: `ad:order:view:${order.orderCode}`,
    }]));

    const navRow = [];
    if (safePage > 0) {
      navRow.push({ text: "⬅ Trang trước", callback_data: `ad:orders:list:${safePage - 1}` });
    }
    if (start + pageSize < orders.length) {
      navRow.push({ text: "Trang sau ➡", callback_data: `ad:orders:list:${safePage + 1}` });
    }
    if (navRow.length > 0) {
      rows.push(navRow);
    }

    rows.push([{ text: "Tìm mã đơn", callback_data: "ad:orders:find:start" }]);
    rows.push([{ text: "Về bảng điều khiển", callback_data: "ad:home" }]);

    return {
      reply_markup: {
        inline_keyboard: rows,
      },
    };
  }

  function buildAdminOrderDetailKeyboard(order) {
    const rows = [];
    if (order.status !== orderService.ORDER_STATUS.DELIVERED) {
      rows.push([{ text: "Xác nhận đã giao", callback_data: `ad:order:delivered:${order.orderCode}` }]);
    }

    rows.push([
      { text: "⬅ Danh sách đơn", callback_data: "ad:orders:list:0" },
      { text: "Về bảng điều khiển", callback_data: "ad:home" },
    ]);

    return {
      reply_markup: {
        inline_keyboard: rows,
      },
    };
  }

  function buildAdminMenuKeyboard(items, page = 0) {
    const pageSize = 8;
    const safePage = Math.max(0, page);
    const start = safePage * pageSize;
    const current = items.slice(start, start + pageSize);
    const rows = current.map((item) => ([{
      text: `${item.itemId} | ${item.name}`,
      callback_data: `ad:menu:view:${item.itemId}`,
    }]));

    const navRow = [];
    if (safePage > 0) {
      navRow.push({ text: "⬅ Trang trước", callback_data: `ad:menu:list:${safePage - 1}` });
    }
    if (start + pageSize < items.length) {
      navRow.push({ text: "Trang sau ➡", callback_data: `ad:menu:list:${safePage + 1}` });
    }
    if (navRow.length > 0) {
      rows.push(navRow);
    }

    rows.push([{ text: "Thêm món mới", callback_data: "ad:menu:add:start" }]);
    rows.push([{ text: "Về bảng điều khiển", callback_data: "ad:home" }]);

    return {
      reply_markup: {
        inline_keyboard: rows,
      },
    };
  }

  function buildAdminMenuItemKeyboard(item) {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Sửa thông tin", callback_data: `ad:menu:edit:start:${item.itemId}` },
            { text: "Xóa món", callback_data: `ad:menu:delete:confirm:${item.itemId}` },
          ],
          [
            {
              text: item.available ? "Đang bán: ON (bấm để tắt)" : "Đang bán: OFF (bấm để bật)",
              callback_data: `ad:menu:toggle:${item.itemId}`,
            },
          ],
          [
            { text: "⬅ Danh sách menu", callback_data: "ad:menu:list:0" },
            { text: "Về bảng điều khiển", callback_data: "ad:home" },
          ],
        ],
      },
    };
  }

  function buildAdminMenuEditFieldKeyboard(itemId) {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Tên", callback_data: `ad:menu:editfield:${itemId}:name` },
            { text: "Danh mục", callback_data: `ad:menu:editfield:${itemId}:category` },
          ],
          [
            { text: "Giá M", callback_data: `ad:menu:editfield:${itemId}:priceM` },
            { text: "Giá L", callback_data: `ad:menu:editfield:${itemId}:priceL` },
          ],
          [
            { text: "Mô tả", callback_data: `ad:menu:editfield:${itemId}:description` },
            { text: "Đang bán", callback_data: `ad:menu:editfield:${itemId}:available` },
          ],
          [{ text: "⬅ Quay lại món", callback_data: `ad:menu:view:${itemId}` }],
        ],
      },
    };
  }

  function safe(handler) {
    return async (msg, match) => {
      try {
        await handler(msg, match);
      } catch (error) {
        logEvent("ERROR", {
          chatId: msg.chat.id,
          message: error.message,
          stack: error.stack,
        });
        await bot.sendMessage(
          msg.chat.id,
          "Đã có lỗi xảy ra, bạn thử lại giúp mình nhé. Dùng /help để xem cú pháp chuẩn."
        );
      }
    };
  }

  function getCartOrEmpty(chatId) {
    const cart = cartService.getCart(chatId);
    return {
      ...cart,
      items: Array.isArray(cart.items) ? cart.items : [],
    };
  }

  function getAvailableToppings() {
    return menuService
      .getMenu()
      .filter((item) => item.available && item.category === "Topping");
  }

  async function sendAdminHelp(chatId) {
    await bot.sendMessage(
      chatId,
      [
        "Lenh admin:",
        "/orders - Xem danh sach don",
        "/order <orderCode> - Xem chi tiet don",
        "/delivered <orderCode> - Xac nhan da giao",
        "/menuadmin - Xem menu hien tai",
        "/menuadd <item_id>|<ten>|<category>|<price_m>|<price_l>|<available>|<description>",
        "/menuedit <item_id>|field=value|field=value",
        "/menudelete <item_id>",
        "",
        "Field cho /menuedit: name, category, description, price_m, price_l, available",
        "Category hop le: Trà Sữa, Trà Trái Cây, Cà Phê, Đá Xay, Topping",
        "",
        "Meo dung nhanh: thay vi go lenh, ban co the bam cac nut trong giao dien admin.",
      ].join("\n"),
      getAdminKeyboard()
    );
  }

  async function sendAdminDashboard(chatId, title = "Bảng điều khiển admin") {
    clearAdminFlow(chatId);
    await bot.sendMessage(chatId, title, getAdminKeyboard());
    await bot.sendMessage(chatId, "Chọn thao tác bên dưới:", buildAdminHomeInlineKeyboard());
  }

  async function sendAdminOrdersList(chatId, page = 0) {
    const orders = await orderService.listOrders();
    if (!orders.length) {
      await bot.sendMessage(chatId, "Chưa có đơn hàng nào.", getAdminKeyboard());
      return;
    }

    await bot.sendMessage(
      chatId,
      "Danh sách đơn hàng (bấm vào mã đơn để xem chi tiết):",
      buildAdminOrdersKeyboard(orders, page)
    );
  }

  async function sendAdminOrderDetail(chatId, orderCode) {
    const order = await orderService.getOrderByCode(orderCode);
    if (!order) {
      await bot.sendMessage(chatId, `Không tìm thấy đơn ${orderCode}.`, getAdminKeyboard());
      return;
    }

    const detail = buildAdminOrderDetail(order);
    await bot.sendMessage(chatId, detail, buildAdminOrderDetailKeyboard(order));
  }

  async function sendAdminMenuList(chatId, page = 0) {
    const items = menuService.getMenu();
    if (!items.length) {
      await bot.sendMessage(chatId, "Menu đang trống.", getAdminKeyboard());
      return;
    }

    await bot.sendMessage(
      chatId,
      "Danh sách menu (bấm vào món để xem/sửa/xóa):",
      buildAdminMenuKeyboard(items, page)
    );
  }

  async function sendAdminMenuItemDetail(chatId, itemId) {
    const item = menuService.getItemByCode(itemId);
    if (!item) {
      await bot.sendMessage(chatId, `Không tìm thấy món ${itemId}.`, getAdminKeyboard());
      return;
    }

    const lines = [
      `${item.itemId} | ${item.name}`,
      `Danh mục: ${item.category}`,
      `Giá M: ${item.priceM}đ`,
      `Giá L: ${item.priceL}đ`,
      `Đang bán: ${item.available ? "ON" : "OFF"}`,
      `Mô tả: ${item.description || "(trống)"}`,
    ];

    await bot.sendMessage(chatId, lines.join("\n"), buildAdminMenuItemKeyboard(item));
  }

  async function handleAdminFlowInput(chatId, text) {
    const flow = getAdminFlow(chatId);
    if (!flow || !flow.action) {
      return false;
    }

    if (flow.action === "FIND_ORDER") {
      clearAdminFlow(chatId);
      await sendAdminOrderDetail(chatId, String(text || "").trim().toUpperCase());
      return true;
    }

    if (flow.action === "ADD_MENU") {
      const draft = { ...(flow.draft || {}) };
      const step = flow.step || "itemId";
      const orderedSteps = ["itemId", "name", "category", "priceM", "priceL", "available", "description"];

      draft[step] = text;
      const currentIndex = orderedSteps.indexOf(step);
      const nextStep = currentIndex >= 0 && currentIndex < orderedSteps.length - 1 ? orderedSteps[currentIndex + 1] : null;

      if (nextStep) {
        saveAdminFlow(chatId, { action: "ADD_MENU", step: nextStep, draft });
        const questions = {
          itemId: "Nhập mã món (VD: TS20)",
          name: "Nhập tên món",
          category: "Nhập danh mục (Trà Sữa, Trà Trái Cây, Cà Phê, Đá Xay, Topping)",
          priceM: "Nhập giá size M (số nguyên)",
          priceL: "Nhập giá size L (số nguyên)",
          available: "Đang bán? nhập true hoặc false",
          description: "Nhập mô tả ngắn cho món",
        };
        await bot.sendMessage(chatId, questions[nextStep], getAdminKeyboard());
        return true;
      }

      const created = menuService.addMenuItem({
        itemId: draft.itemId,
        name: draft.name,
        category: draft.category,
        priceM: draft.priceM,
        priceL: draft.priceL,
        available: draft.available,
        description: draft.description,
      });

      if (!created.ok) {
        clearAdminFlow(chatId);
        await bot.sendMessage(chatId, `Tạo món thất bại: ${created.error}`, getAdminKeyboard());
        await sendAdminDashboard(chatId, "Bạn có thể thử lại bằng nút Thêm món mới");
        return true;
      }

      try {
        await menuService.saveMenuToCsv();
      } catch (error) {
        clearAdminFlow(chatId);
        await bot.sendMessage(chatId, `Đã tạo món nhưng lưu CSV thất bại: ${error.message}`, getAdminKeyboard());
        return true;
      }

      clearAdminFlow(chatId);
      await bot.sendMessage(chatId, `Đã thêm món ${created.item.itemId} - ${created.item.name}.`, getAdminKeyboard());
      await sendAdminMenuItemDetail(chatId, created.item.itemId);
      return true;
    }

    if (flow.action === "EDIT_MENU_FIELD") {
      const itemId = flow.itemId;
      const field = flow.field;
      const updatePayload = { [field]: text };

      const updated = menuService.updateMenuItem(itemId, updatePayload);
      if (!updated.ok) {
        clearAdminFlow(chatId);
        await bot.sendMessage(chatId, `Cập nhật thất bại: ${updated.error}`, getAdminKeyboard());
        return true;
      }

      try {
        await menuService.saveMenuToCsv();
      } catch (error) {
        clearAdminFlow(chatId);
        await bot.sendMessage(chatId, `Đã cập nhật nhưng lưu CSV thất bại: ${error.message}`, getAdminKeyboard());
        return true;
      }

      clearAdminFlow(chatId);
      await bot.sendMessage(chatId, `Đã cập nhật ${updated.item.itemId}.`, getAdminKeyboard());
      await sendAdminMenuItemDetail(chatId, updated.item.itemId);
      return true;
    }

    return false;
  }

  async function sendAdminMenu(chatId) {
    const items = menuService.getMenu();
    if (!items.length) {
      await bot.sendMessage(chatId, "Menu dang trong.", getAdminKeyboard());
      return;
    }

    const lines = items.map((item) => {
      const active = item.available ? "ON" : "OFF";
      return `${item.itemId} | ${item.name} | ${item.category} | M:${item.priceM} L:${item.priceL} | ${active}`;
    });

    await bot.sendMessage(chatId, ["MENU HIEN TAI:", ...lines].join("\n"), getAdminKeyboard());
  }

  async function sendMenu(chatId) {
    const grouped = menuService.getMenuByCategories();
    const categoryOrder = [
      "Trà Sữa",
      "Trà Trái Cây",
      "Cà Phê",
      "Đá Xay",
      "Topping",
    ];

    const chunks = ["MENU QUAN TRA SUA"]; 

    for (const category of categoryOrder) {
      const items = grouped[category] || [];
      if (items.length === 0) {
        continue;
      }

      chunks.push(`\n${category}:`);
      for (const item of items) {
        if (category === "Topping") {
          chunks.push(`${item.index}. ${item.name} - ${formatCurrencyVND(item.priceM)}`);
        } else {
          chunks.push(
            `${item.index}. ${item.name} | M: ${formatCurrencyVND(item.priceM)} | L: ${formatCurrencyVND(item.priceL)}`
          );
        }
      }
    }

    chunks.push("\nHuong dan nhanh:");
    chunks.push("/add <item_code> <size> <quantity>");
    chunks.push('/add "<item_name>" <size> <quantity>');
    chunks.push("/cart");
    chunks.push("/checkout");

    await bot.sendMessage(chatId, chunks.join("\n"), getMainKeyboard());
  }

  function formatAdminOrderLine(order) {
    return `${order.orderCode} - ${order.customerName} - ${order.totalAmount}đ - ${order.status} - ${order.createdAt}`;
  }

  function buildAdminOrderDetail(order) {
    const itemLines = order.items.map((item) => `- ${item.quantity}x ${item.name} ${item.size}`).join("\n");
    const address = order.deliveryMethod === "delivery" ? order.address : "Nhan tai quan";

    return [
      `🧾 ĐƠN MỚI: ${order.orderCode}`,
      `Khách: ${order.customerName}`,
      `SĐT: ${order.phone || "(không có)"}`,
      `Địa chỉ: ${address}`,
      "Món:",
      itemLines,
      `Tổng: ${order.totalAmount}đ`,
      `Trạng thái: ${order.status} | Thanh toán: ${order.paymentStatus}`,
    ].join("\n");
  }

  async function notifyAdminNewOrder(order) {
    if (!adminChatId) {
      return;
    }

    try {
      await bot.sendMessage(adminChatId, buildAdminOrderDetail(order));
    } catch (error) {
      logEvent("ADMIN_NOTIFY_FAILED", { orderCode: order.orderCode, reason: error.message });
    }
  }

  function resolveMenuItemFromAddTarget(target, targetType) {
    if (targetType === "index") {
      const item = menuService.getItemByIndex(Number.parseInt(target, 10));
      if (!item) {
        return { item: null, error: "Mon khong ton tai. Dung /menu de xem danh sach." };
      }

      return { item };
    }

    const byCode = menuService.getItemByCode(target);
    if (byCode) {
      return { item: byCode };
    }

    const matches = menuService.searchItemsByName(target, {
      limit: 5,
      minScore: 0.35,
    });

    if (matches.length === 0) {
      return { item: null, error: "Khong tim thay mon phu hop. Dung /menu de xem lai." };
    }

    const [first, second] = matches;
    const isConfident = first.score >= 0.75 && (!second || first.score - second.score >= 0.15);

    if (isConfident) {
      return { item: first.item };
    }

    return { item: null, matches };
  }

  function resolveToppingItems(toppingNames) {
    const names = Array.isArray(toppingNames) ? toppingNames : [];
    if (!names.length) {
      return [];
    }

    const availableToppings = getAvailableToppings();
    const resolved = [];

    for (const name of names) {
      const query = menuService.normalizeText(name);
      if (!query) {
        continue;
      }

      const match = availableToppings.find((top) => {
        const n = menuService.normalizeText(top.name);
        return n.includes(query) || query.includes(n);
      });

      if (match && !resolved.some((item) => item.itemId === match.itemId)) {
        resolved.push(match);
      }
    }

    return resolved;
  }

  function recalcCartLinePrice(lineItem) {
    const menuItem = menuService.getItemByCode(lineItem.itemId);
    const normalizedSize = String(lineItem.size || "M").toUpperCase() === "L" ? "L" : "M";
    lineItem.size = normalizedSize;

    let baseUnitPrice = Number(lineItem.baseUnitPrice || lineItem.unitPrice || 0);
    if (menuItem) {
      baseUnitPrice = normalizedSize === "L" ? Number(menuItem.priceL || 0) : Number(menuItem.priceM || 0);
      lineItem.name = menuItem.name;
      lineItem.category = menuItem.category;
    }

    const toppingDetails = Array.isArray(lineItem.toppingDetails) ? lineItem.toppingDetails : [];
    const toppingUnitTotal = toppingDetails.reduce((sum, top) => sum + Number(top.unitPrice || 0), 0);
    lineItem.baseUnitPrice = baseUnitPrice;
    lineItem.unitPrice = baseUnitPrice + toppingUnitTotal;
    lineItem.toppings = toppingDetails.map((top) => top.name);
  }

  function resolveCartLineByTarget(cart, draft) {
    const items = cart && Array.isArray(cart.items) ? cart.items : [];
    if (!items.length) {
      return null;
    }

    const targetItemId = String(draft.targetItemId || draft.itemId || "").trim().toUpperCase();
    const targetItemName = String(draft.targetItemName || draft.itemName || "").trim();
    const targetSize = String(draft.size || "").trim().toUpperCase();

    if (targetItemId) {
      const idx = items.findIndex((item) => String(item.itemId || "").toUpperCase() === targetItemId);
      if (idx >= 0) {
        return idx + 1;
      }
    }

    if (!targetItemName) {
      return null;
    }

    const query = menuService.normalizeText(targetItemName);
    const idx = items.findIndex((item) => {
      const itemName = menuService.normalizeText(item.name || "");
      const sizeMatches = !targetSize || String(item.size || "").toUpperCase() === targetSize;
      return sizeMatches && (itemName.includes(query) || query.includes(itemName));
    });

    return idx >= 0 ? idx + 1 : null;
  }

  function parseSizeChoice(text) {
    const normalized = menuService.normalizeText(text || "");
    if (["size m", "m", "size vua", "vua", "size nho", "nho", "ly vua", "ly nho"].includes(normalized)) {
      return "M";
    }
    if (["size l", "l", "size lon", "lon", "to", "ly lon"].includes(normalized)) {
      return "L";
    }

    if (/\b(size|ly)\s*(m|vua|nho)\b/.test(normalized)) {
      return "M";
    }

    if (/\b(size|ly)\s*(l|lon|to)\b/.test(normalized)) {
      return "L";
    }

    return null;
  }

  function parseQuantityChoice(text) {
    const normalized = menuService.normalizeText(text || "");
    const numericMatch = normalized.match(/\b(\d{1,2})\b/);
    const direct = numericMatch ? Number.parseInt(numericMatch[1], 10) : Number.parseInt(normalized, 10);
    if (Number.isInteger(direct) && direct > 0) {
      return direct;
    }

    const words = {
      mot: 1,
      một: 1,
      hai: 2,
      ba: 3,
      bon: 4,
      bốn: 4,
      nam: 5,
      năm: 5,
    };

    return words[normalized] || null;
  }

  function parseToppingNamesFromText(text) {
    const normalized = menuService.normalizeText(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) {
      return [];
    }

    return normalized
      .split(/,|\bva\b|\bvoi\b|\bthem\b/)
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !["topping", "chon", "chọn", "xong"].includes(part));
  }

  function pickMenuItemFromParsedTarget(parsed) {
    const rawIndex = Number.parseInt(parsed.targetIndex, 10);
    let item = Number.isInteger(rawIndex) && rawIndex > 0 ? menuService.getItemByIndex(rawIndex) : null;

    if (!item && parsed.targetItemName) {
      const resolved = resolveMenuItemFromAddTarget(parsed.targetItemName, "code_or_name");
      if (!resolved.error && !resolved.matches) {
        item = resolved.item;
      }
    }

    return item;
  }

  async function promptPendingAiAdd(chatId, pending) {
    const step = String(pending.step || "size");

    if (step === "size") {
      await bot.sendMessage(
        chatId,
        `Món ${pending.itemName} bạn muốn size nào? M hay L?`,
        getAiChooseSizeKeyboard()
      );
      return;
    }

    if (step === "quantity") {
      await bot.sendMessage(
        chatId,
        `Bạn chọn size ${pending.size}. Giờ chọn số lượng cho ${pending.itemName}:`,
        getAiChooseQuantityKeyboard()
      );
      return;
    }

    if (step === "toppingDecision") {
      await bot.sendMessage(
        chatId,
        `Bạn có muốn thêm topping cho ${pending.itemName} không?`,
        getAiToppingDecisionKeyboard()
      );
      return;
    }

    if (step === "toppingSelect") {
      const toppingNames = getAvailableToppings().slice(0, 8).map((top) => top.name).join(", ");
      await bot.sendMessage(
        chatId,
        [
          "Bạn nhập topping muốn thêm (cách nhau bằng dấu phẩy hoặc chữ 'và').",
          `Ví dụ: trân châu, pudding`,
          toppingNames ? `Gợi ý topping: ${toppingNames}` : "",
          "Hoặc bấm 'Bỏ qua topping'.",
        ].filter(Boolean).join("\n"),
        getAiToppingDecisionKeyboard()
      );
    }
  }

  async function finalizePendingAiAdd(chatId) {
    const session = sessionService.getSession(chatId);
    const pending = session && session.data ? session.data.aiPendingAdd : null;
    if (!pending) {
      return false;
    }

    const chosenSize = String(pending.size || "").toUpperCase();
    const chosenQuantity = Number.parseInt(pending.quantity, 10);
    if (!["M", "L"].includes(chosenSize) || !Number.isInteger(chosenQuantity) || chosenQuantity <= 0) {
      await promptPendingAiAdd(chatId, {
        ...pending,
        step: !["M", "L"].includes(chosenSize) ? "size" : "quantity",
      });
      return true;
    }

    const menuItem = menuService.getItemByCode(pending.itemId);
    if (!menuItem) {
      sessionService.mergeData(chatId, { aiPendingAdd: null });
      await bot.sendMessage(chatId, "Mon tam giu khong con trong menu. Ban chon mon khac nhe.", getAiPostActionKeyboard());
      return true;
    }

    const addCommand = `${menuItem.itemId} ${chosenSize} ${chosenQuantity}`;
    const validation = validateAddCommand(addCommand, menuItem);
    if (!validation.isValid) {
      sessionService.mergeData(chatId, { aiPendingAdd: null });
      await bot.sendMessage(chatId, `Khong the them mon: ${validation.error}`, getAiPostActionKeyboard());
      return true;
    }

    const toppingItems = (pending.toppingIds || [])
      .map((itemId) => menuService.getItemByCode(itemId))
      .filter((item) => item && item.category === "Topping");
    const toppingUnitTotal = toppingItems.reduce((sum, top) => sum + Number(top.priceM || 0), 0);

    cartService.addItem(chatId, {
      itemId: menuItem.itemId,
      name: menuItem.name,
      category: menuItem.category,
      size: validation.size,
      quantity: validation.quantity,
      unitPrice: validation.unitPrice + toppingUnitTotal,
      baseUnitPrice: validation.unitPrice,
      toppingDetails: toppingItems.map((top) => ({
        itemId: top.itemId,
        name: top.name,
        unitPrice: Number(top.priceM || 0),
      })),
      toppings: toppingItems.map((top) => top.name),
      note: pending.note || "",
    });

    sessionService.mergeData(chatId, { aiPendingAdd: null });
    const toppingText = toppingItems.length > 0 ? toppingItems.map((top) => top.name).join(", ") : "Không";
    await bot.sendMessage(
      chatId,
      [
        `Mình đã thêm ${validation.quantity} ${menuItem.name} size ${validation.size} vào giỏ rồi nhé.`,
        `Topping: ${toppingText}`,
        ...buildAiNextStepHint(),
      ].join("\n"),
      getAiPostActionKeyboard()
    );
    return true;
  }

  async function handlePendingAiAddInput(chatId, text) {
    const session = sessionService.getSession(chatId);
    const pending = session && session.data ? session.data.aiPendingAdd : null;
    if (!pending) {
      return false;
    }

    const normalized = menuService.normalizeText(text || "");
    if (["huy chon mon", "huy mon", "huy", "cancel", "stop", "dung dat mon"].includes(normalized)) {
      sessionService.mergeData(chatId, { aiPendingAdd: null });
      await bot.sendMessage(chatId, "Mình đã hủy món đang chọn dở.", getAiPostActionKeyboard());
      return true;
    }

    const step = String(pending.step || "size");

    if (step === "size") {
      const chosenSize = parseSizeChoice(text);
      if (!chosenSize) {
        await bot.sendMessage(chatId, "Bạn chọn giúp mình size M hoặc L nhé.", getAiChooseSizeKeyboard());
        return true;
      }

      const nextPending = {
        ...pending,
        size: chosenSize,
        step: "quantity",
      };
      sessionService.mergeData(chatId, { aiPendingAdd: nextPending });
      await promptPendingAiAdd(chatId, nextPending);
      return true;
    }

    if (step === "quantity") {
      if (normalized === "so khac" || normalized === "số khác") {
        await bot.sendMessage(chatId, "Bạn nhập số lượng mong muốn (số nguyên > 0) nhé.", getAiChooseQuantityKeyboard());
        return true;
      }

      const quantity = parseQuantityChoice(text);
      if (!quantity) {
        await bot.sendMessage(chatId, "Số lượng chưa hợp lệ. Bạn nhập số nguyên > 0 nhé.", getAiChooseQuantityKeyboard());
        return true;
      }

      const nextPending = {
        ...pending,
        quantity,
        step: "toppingDecision",
      };
      sessionService.mergeData(chatId, { aiPendingAdd: nextPending });
      await promptPendingAiAdd(chatId, nextPending);
      return true;
    }

    if (step === "toppingDecision") {
      if (["bo qua topping", "bỏ qua topping", "bo qua", "boqua", "khong", "không", "ko", "k", "no", "thoi", "khoi topping", "khong can topping", "ko can topping", "khong them", "ko them"].includes(normalized)) {
        sessionService.mergeData(chatId, {
          aiPendingAdd: {
            ...pending,
            toppingIds: [],
          },
        });
        await finalizePendingAiAdd(chatId);
        return true;
      }

      if (["them topping", "thêm topping", "chon topping", "chọn topping", "co", "có", "yes", "ok them", "them", "co them", "co topping"].includes(normalized)) {
        const nextPending = {
          ...pending,
          step: "toppingSelect",
        };
        sessionService.mergeData(chatId, { aiPendingAdd: nextPending });
        await promptPendingAiAdd(chatId, nextPending);
        return true;
      }

      await bot.sendMessage(chatId, "Bạn chọn 'Thêm topping' hoặc 'Bỏ qua topping' giúp mình nhé.", getAiToppingDecisionKeyboard());
      return true;
    }

    if (step === "toppingSelect") {
      if (["bo qua topping", "bỏ qua topping", "bo qua", "boqua", "khong", "không", "ko", "k", "no", "thoi", "khoi topping", "khong can topping", "ko can topping", "khong them", "ko them"].includes(normalized)) {
        sessionService.mergeData(chatId, {
          aiPendingAdd: {
            ...pending,
            toppingIds: [],
          },
        });
        await finalizePendingAiAdd(chatId);
        return true;
      }

      const toppingNames = parseToppingNamesFromText(text);
      const toppingItems = resolveToppingItems(toppingNames);
      if (toppingItems.length === 0) {
        await bot.sendMessage(
          chatId,
          "Mình chưa nhận ra topping nào. Bạn thử nhập lại, ví dụ: trân châu, pudding.",
          getAiToppingDecisionKeyboard()
        );
        return true;
      }

      sessionService.mergeData(chatId, {
        aiPendingAdd: {
          ...pending,
          toppingIds: toppingItems.map((top) => top.itemId),
        },
      });
      await finalizePendingAiAdd(chatId);
      return true;
    }

    await promptPendingAiAdd(chatId, pending);
    return true;
  }

  async function tryAddFromAi(chatId, text) {
    if (!llmService) {
      return false;
    }

    const parsed = await llmService.parseOrderMessage(text, menuService.getMenu());
    if (!parsed || !Array.isArray(parsed.items)) {
      return false;
    }

    const supportedIntents = [
      "add_to_cart",
      "update_cart",
      "checkout",
      "show_menu",
      "show_cart",
      "show_item_description",
      "show_item_price",
      "clear_cart",
      "help",
      "switch_mode",
    ];
    if (!supportedIntents.includes(parsed.intent)) {
      return false;
    }

    if (parsed.intent === "show_menu") {
      await sendMenu(chatId);
      return true;
    }

    if (parsed.intent === "show_cart") {
      await sendCart(chatId);
      return true;
    }

    if (parsed.intent === "show_item_description") {
      const item = pickMenuItemFromParsedTarget(parsed);

      if (!item) {
        await bot.sendMessage(chatId, "Mình chưa xác định được món cần xem mô tả. Bạn có thể nói: 'xem mô tả món số 6'.", getAiPostActionKeyboard());
        return true;
      }

      const description = item.description || "Mon nay chua co mo ta chi tiet.";
      const priceText = item.category === "Topping"
        ? `Gia: ${formatCurrencyVND(item.priceM)}`
        : `Gia M: ${formatCurrencyVND(item.priceM)} | L: ${formatCurrencyVND(item.priceL)}`;

      await bot.sendMessage(
        chatId,
        [
          `${item.itemId} - ${item.name}`,
          `Mo ta: ${description}`,
          priceText,
        ].join("\n"),
        getAiPostActionKeyboard()
      );
      return true;
    }

    if (parsed.intent === "show_item_price") {
      const item = pickMenuItemFromParsedTarget(parsed);

      if (!item) {
        await bot.sendMessage(chatId, "Mình chưa xác định được món cần xem giá. Bạn có thể nói: 'xem giá món số 6'.", getAiPostActionKeyboard());
        return true;
      }

      const lines = [
        `${item.itemId} - ${item.name}`,
      ];

      if (item.category === "Topping") {
        lines.push(`Giá: ${formatCurrencyVND(item.priceM)}`);
      } else {
        lines.push(`Giá M: ${formatCurrencyVND(item.priceM)}`);
        lines.push(`Giá L: ${formatCurrencyVND(item.priceL)}`);
      }

      await bot.sendMessage(chatId, lines.join("\n"), getAiPostActionKeyboard());
      return true;
    }

    if (parsed.intent === "clear_cart") {
      cartService.clearCart(chatId);
      await bot.sendMessage(chatId, "Mình đã xóa toàn bộ giỏ hàng cho bạn.", getAiPostActionKeyboard());
      return true;
    }

    if (parsed.intent === "help") {
      await bot.sendMessage(
        chatId,
        "Bạn có thể nhắn tự nhiên như: 'xem menu', 'xem giỏ hàng', 'checkout', 'giảm mocha còn 1', 'đổi topping trân châu cho mocha'.",
        getAiPostActionKeyboard()
      );
      return true;
    }

    if (parsed.intent === "switch_mode") {
      await bot.sendMessage(chatId, "Bot đang ở AI mode rồi. Bạn cứ chat tự nhiên để đặt món nhé.", getAiPostActionKeyboard());
      return true;
    }

    if (parsed.intent === "checkout") {
      await startCheckoutFromAi(chatId, parsed);
      return true;
    }

    const ops = parsed.items.length > 0 ? parsed.items : [{}];
    const successes = [];
    const failures = [];
    const mutableCart = cartService.getOrCreateCart(chatId);
    let pendingSizeRequest = null;

    for (const op of ops) {
      const action = String(op.action || (parsed.intent === "add_to_cart" ? "add" : "set_quantity")).toLowerCase();

      if (action === "add") {
        const rawTarget = op.itemId || op.itemName;
        if (!rawTarget) {
          failures.push("Khong xac dinh duoc mon can them.");
          continue;
        }

        const resolved = resolveMenuItemFromAddTarget(rawTarget, "code_or_name");
        if (resolved.error || resolved.matches || !resolved.item) {
          failures.push(`Khong chac mon '${rawTarget}'.`);
          continue;
        }

        const size = String(op.size || "").toUpperCase();
        const quantity = Number.parseInt(op.quantity, 10);
        const normalizedSize = ["M", "L"].includes(size) ? size : "";
        const normalizedQuantity = Number.isInteger(quantity) && quantity > 0 ? quantity : null;
        const toppingItems = resolveToppingItems(op.toppings);

        if (!normalizedSize) {
          if (!pendingSizeRequest) {
            pendingSizeRequest = {
              step: "size",
              itemId: resolved.item.itemId,
              itemName: resolved.item.name,
              size: "",
              quantity: normalizedQuantity,
              toppingIds: toppingItems.map((top) => top.itemId),
              note: String(op.note || "").trim(),
            };
          }
          failures.push(`Thieu size cho mon ${resolved.item.name}.`);
          continue;
        }

        if (!normalizedQuantity) {
          if (!pendingSizeRequest) {
            pendingSizeRequest = {
              step: "quantity",
              itemId: resolved.item.itemId,
              itemName: resolved.item.name,
              size: normalizedSize,
              quantity: null,
              toppingIds: toppingItems.map((top) => top.itemId),
              note: String(op.note || "").trim(),
            };
          }
          failures.push(`Thieu so luong cho mon ${resolved.item.name}.`);
          continue;
        }

        const addCommand = `${resolved.item.itemId} ${normalizedSize} ${normalizedQuantity}`;
        const validation = validateAddCommand(addCommand, resolved.item);
        if (!validation.isValid) {
          failures.push(`Mon ${resolved.item.name}: ${validation.error}`);
          continue;
        }

        const toppingUnitTotal = toppingItems.reduce((sum, top) => sum + Number(top.priceM || 0), 0);
        cartService.addItem(chatId, {
          itemId: resolved.item.itemId,
          name: resolved.item.name,
          category: resolved.item.category,
          size: validation.size,
          quantity: validation.quantity,
          unitPrice: validation.unitPrice + toppingUnitTotal,
          baseUnitPrice: validation.unitPrice,
          toppingDetails: toppingItems.map((top) => ({
            itemId: top.itemId,
            name: top.name,
            unitPrice: Number(top.priceM || 0),
          })),
          toppings: toppingItems.map((top) => top.name),
          note: String(op.note || "").trim(),
        });

        successes.push(`Mình đã thêm ${validation.quantity} ${resolved.item.name} size ${validation.size} vào giỏ.`);
        continue;
      }

      const lineNumber = resolveCartLineByTarget(mutableCart, op);
      if (!lineNumber) {
        failures.push(`Khong tim thay mon can sua '${op.targetItemName || op.itemName || op.itemId || ""}'.`);
        continue;
      }

      if (action === "remove") {
        const result = cartService.removeItemByLine(chatId, lineNumber);
        if (!result.ok) {
          failures.push(result.error);
          continue;
        }
        successes.push(`Mình đã bỏ ${result.removed.name} khỏi giỏ.`);
        continue;
      }

      if (action === "set_quantity") {
        const qty = Number.parseInt(op.quantity, 10);
        if (!Number.isInteger(qty) || qty < 0) {
          failures.push("So luong khong hop le.");
          continue;
        }
        const result = cartService.updateItemQuantityByLine(chatId, lineNumber, qty);
        if (!result.ok) {
          failures.push(result.error);
          continue;
        }

        if (result.deleted && result.removed) {
          successes.push(`Mình đã bỏ ${result.removed.name} khỏi giỏ.`);
        } else {
          successes.push(`Mình đã đổi số lượng ${result.item.name} thành ${result.item.quantity}.`);
        }
        continue;
      }

      const lineItem = mutableCart.items[lineNumber - 1];
      if (!lineItem) {
        failures.push("Khong tim thay dong gio hang de cap nhat.");
        continue;
      }

      if (["add_toppings", "remove_toppings", "replace_toppings"].includes(action)) {
        const requestedToppings = resolveToppingItems(op.toppings);
        const currentToppings = Array.isArray(lineItem.toppingDetails) ? [...lineItem.toppingDetails] : [];

        if (action === "replace_toppings") {
          lineItem.toppingDetails = requestedToppings.map((top) => ({
            itemId: top.itemId,
            name: top.name,
            unitPrice: Number(top.priceM || 0),
          }));
        } else if (action === "add_toppings") {
          const map = new Map(currentToppings.map((top) => [top.itemId, top]));
          for (const top of requestedToppings) {
            map.set(top.itemId, {
              itemId: top.itemId,
              name: top.name,
              unitPrice: Number(top.priceM || 0),
            });
          }
          lineItem.toppingDetails = Array.from(map.values());
        } else {
          const removeIds = new Set(requestedToppings.map((top) => top.itemId));
          lineItem.toppingDetails = currentToppings.filter((top) => !removeIds.has(top.itemId));
        }

        if (op.size) {
          lineItem.size = String(op.size).toUpperCase() === "L" ? "L" : "M";
        }

        if (op.quantity !== undefined && op.quantity !== null && op.quantity !== "") {
          const qty = Number.parseInt(op.quantity, 10);
          if (Number.isInteger(qty) && qty >= 0) {
            const q = cartService.updateItemQuantityByLine(chatId, lineNumber, qty);
            if (!q.ok) {
              failures.push(q.error);
              continue;
            }
            if (q.deleted) {
              successes.push(`Mình đã bỏ ${q.removed.name} khỏi giỏ.`);
              continue;
            }
          }
        }

        recalcCartLinePrice(lineItem);
        successes.push(`Mình đã cập nhật topping cho ${lineItem.name}.`);
        continue;
      }

      failures.push(`AI chua ho tro thao tac '${action}'.`);
    }

    if (successes.length === 0 && failures.length > 0) {
      if (pendingSizeRequest) {
        sessionService.mergeData(chatId, { aiPendingAdd: pendingSizeRequest });
        await promptPendingAiAdd(chatId, pendingSizeRequest);
        return true;
      }

      await bot.sendMessage(
        chatId,
        [
          "Mình chưa xử lý được yêu cầu chỉnh giỏ hàng.",
          ...failures.slice(0, 3).map((m) => `- ${m}`),
          "Bạn nói rõ hơn giúp mình nhé, ví dụ:",
          "- giảm mocha còn 1",
          "- xóa caramel",
          "- đổi topping trân châu cho mocha",
        ].join("\n"),
        getAiPostActionKeyboard()
      );
      return true;
    }

    await bot.sendMessage(
      chatId,
      [
        "Mình xử lý xong rồi nè:",
        ...successes.map((m) => `- ${m}`),
        ...(failures.length ? ["", "Mình chưa làm được một vài ý:", ...failures.slice(0, 3).map((m) => `- ${m}`)] : []),
        ...buildAiNextStepHint(),
      ].join("\n"),
      getAiPostActionKeyboard()
    );

    if (pendingSizeRequest) {
      sessionService.mergeData(chatId, { aiPendingAdd: pendingSizeRequest });
      await promptPendingAiAdd(chatId, pendingSizeRequest);
    }

    return true;
  }

  async function sendCart(chatId) {
    const cart = getCartOrEmpty(chatId);
    const message = [
      buildCartMessage(cart),
      "",
      "Mẹo: bấm nút ➕/➖ để chỉnh số lượng nhanh hoặc dùng /qty <so_dong> <so_luong> (nhập 0 để xóa món).",
    ].join("\n");
    const adjustKeyboard = buildCartAdjustKeyboard(cart);

    if (adjustKeyboard) {
      await bot.sendMessage(chatId, message, adjustKeyboard);
      return;
    }

    await bot.sendMessage(chatId, message, getMainKeyboard());
  }

  async function startCheckout(chatId) {
    if (cartService.isCartEmpty(chatId)) {
      await bot.sendMessage(chatId, "Giỏ hàng đang trống. Dùng /menu rồi /add trước khi checkout.");
      return;
    }

    sessionService.resetSession(chatId);
    sessionService.setState(chatId, STATES.WAITING_NAME);

    await bot.sendMessage(chatId, "Nhap ten nguoi nhan: ");
  }

  function mapMissingFieldLabel(field) {
    const map = {
      customerName: "ten nguoi nhan",
      phone: "so dien thoai",
      deliveryMethod: "hinh thuc nhan hang",
      address: "dia chi giao hang",
    };
    return map[field] || field;
  }

  async function startCheckoutFromAi(chatId, parsed = null) {
    if (cartService.isCartEmpty(chatId)) {
      await bot.sendMessage(chatId, "Giỏ hàng đang trống. Bạn chọn món trước rồi mình mới checkout được nhé.", getAiPostActionKeyboard());
      return;
    }

    sessionService.resetSession(chatId);
    const checkoutInfo = parsed && parsed.checkoutInfo && typeof parsed.checkoutInfo === "object" ? parsed.checkoutInfo : {};

    const customerName = String(checkoutInfo.customerName || "").trim();
    const rawPhone = String(checkoutInfo.phone || "").trim();
    const normalizedPhone = rawPhone ? normalizePhoneNumber(rawPhone) : "";
    const deliveryMethod = normalizeDeliveryMethod(checkoutInfo.deliveryMethod || "");
    const address = String(checkoutInfo.address || "").trim();
    const note = String(checkoutInfo.note || "").trim();

    if (customerName) {
      sessionService.mergeData(chatId, { customerName });
    }

    if (normalizedPhone && isValidVietnamPhone(normalizedPhone)) {
      sessionService.mergeData(chatId, { phone: normalizedPhone });
    }

    if (deliveryMethod) {
      sessionService.mergeData(chatId, { deliveryMethod });
    }

    if (deliveryMethod === "delivery" && address) {
      sessionService.mergeData(chatId, { address });
    }

    if (note) {
      sessionService.mergeData(chatId, { note });
    }

    const missingHints = Array.isArray(parsed && parsed.missingFields)
      ? parsed.missingFields.map((field) => mapMissingFieldLabel(field))
      : [];

    if (!customerName) {
      sessionService.setState(chatId, STATES.WAITING_NAME);
      const hint = missingHints.length ? `\nCon thieu: ${missingHints.join(", ")}.` : "";
      await bot.sendMessage(chatId, `Để giao hàng, bạn cho mình tên người nhận nhé.${hint}`);
      return;
    }

    if (!normalizedPhone || !isValidVietnamPhone(normalizedPhone)) {
      sessionService.setState(chatId, STATES.WAITING_PHONE);
      const reason = rawPhone ? "Số điện thoại bạn nhập chưa hợp lệ." : "Mình chưa có số điện thoại của bạn.";
      await bot.sendMessage(chatId, `${reason} Vui lòng nhập số điện thoại (VD: 0901234567).`);
      return;
    }

    if (!deliveryMethod) {
      sessionService.setState(chatId, STATES.WAITING_DELIVERY_METHOD);
      await bot.sendMessage(chatId, "Bạn muốn nhận tại quán hay giao hàng?", getDeliveryMethodKeyboard());
      return;
    }

    if (deliveryMethod === "delivery" && !address) {
      sessionService.setState(chatId, STATES.WAITING_ADDRESS);
      await bot.sendMessage(chatId, "Bạn gửi mình địa chỉ giao hàng nhé.");
      return;
    }

    if (deliveryMethod === "pickup") {
      sessionService.mergeData(chatId, { address: "" });
    }

    sessionService.setState(chatId, STATES.WAITING_NOTE);
    await bot.sendMessage(
      chatId,
      "Mình đã nhận đủ thông tin cơ bản rồi. Bạn muốn thêm ghi chú gì không? (nhập - để bỏ qua)"
    );
  }

  async function handleCheckoutStateMessage(chatId, text) {
    const session = sessionService.getSession(chatId);

    switch (session.state) {
      case STATES.WAITING_NAME: {
        if (text.length < 2) {
          await bot.sendMessage(chatId, "Ten qua ngan. Vui long nhap lai ten nguoi nhan.");
          return;
        }

        sessionService.mergeData(chatId, { customerName: text });
        sessionService.setState(chatId, STATES.WAITING_PHONE);
        await bot.sendMessage(chatId, "Nhap so dien thoai (VD: 0901234567):");
        return;
      }

      case STATES.WAITING_PHONE: {
        const normalized = normalizePhoneNumber(text);
        if (!isValidVietnamPhone(normalized)) {
          await bot.sendMessage(chatId, "So dien thoai khong hop le. Vui long nhap lai (VD: 0901234567).");
          return;
        }

        sessionService.mergeData(chatId, { phone: normalized });
        sessionService.setState(chatId, STATES.WAITING_DELIVERY_METHOD);
        await bot.sendMessage(chatId, "Chon hinh thuc nhan hang:", getDeliveryMethodKeyboard());
        return;
      }

      case STATES.WAITING_DELIVERY_METHOD: {
        const deliveryMethod = normalizeDeliveryMethod(text);
        if (!deliveryMethod) {
          await bot.sendMessage(chatId, "Chi chap nhan pickup hoac delivery. Vui long chon bang nut ben duoi.", getDeliveryMethodKeyboard());
          return;
        }

        sessionService.mergeData(chatId, { deliveryMethod });

        if (deliveryMethod === "delivery") {
          sessionService.setState(chatId, STATES.WAITING_ADDRESS);
          await bot.sendMessage(chatId, "Nhap dia chi giao hang:");
          return;
        }

        sessionService.mergeData(chatId, { address: "" });
        sessionService.setState(chatId, STATES.WAITING_NOTE);
        await bot.sendMessage(chatId, "Nhap ghi chu them (hoac nhap - de bo qua):");
        return;
      }

      case STATES.WAITING_ADDRESS: {
        if (!text.trim()) {
          await bot.sendMessage(chatId, "Dia chi la bat buoc khi chon delivery. Vui long nhap dia chi.");
          return;
        }

        sessionService.mergeData(chatId, { address: text.trim() });
        sessionService.setState(chatId, STATES.WAITING_NOTE);
        await bot.sendMessage(chatId, "Nhap ghi chu them (hoac nhap - de bo qua):");
        return;
      }

      case STATES.WAITING_NOTE: {
        const note = text.trim() === "-" ? "" : text.trim();
        sessionService.mergeData(chatId, { note });
        sessionService.setState(chatId, STATES.CONFIRMING_ORDER);

        const data = sessionService.getSession(chatId).data;
        const cart = getCartOrEmpty(chatId);

        if (cart.items.length === 0) {
          sessionService.resetSession(chatId);
          await bot.sendMessage(chatId, "Giỏ hàng đang trống nên khong the checkout. Vui long them mon roi thu lai.");
          return;
        }

        const summary = buildOrderSummaryMessage({
          customerName: data.customerName,
          phone: data.phone,
          deliveryMethod: data.deliveryMethod,
          address: data.address || "",
          note: data.note || "",
          items: cart.items,
          totalAmount: cartService.getCartTotal(chatId),
        });

        await bot.sendMessage(chatId, summary);
        return;
      }

      case STATES.CONFIRMING_ORDER: {
        await bot.sendMessage(chatId, "Vui long nhap /confirm de chot don hoac /cancel de huy.");
        return;
      }

      case STATES.WAITING_PAYMENT: {
        await bot.sendMessage(chatId, "Don dang duoc tao, vui long doi trong giay lat.");
        return;
      }

      case STATES.IDLE:
      default:
        return;
    }
  }

  bot.onText(/^\/start$/i, safe(async (msg) => {
    logCommand(msg.chat.id, "/start");
    const isAdmin = isAdminChat(msg.chat.id);

    if (isAdmin) {
      await sendAdminDashboard(
        msg.chat.id,
        [
          "Chao admin.",
          "Ban dang o giao dien quan ly don/menu.",
          "Ban co the bam nut, khong can nho cau lenh.",
        ].join("\n")
      );
      return;
    }

    sessionService.setMode(msg.chat.id, MODES.AI);

    await bot.sendMessage(
      msg.chat.id,
      [
        "Chao ban, minh la bot dat tra sua.",
        "Bot hien dang o AI mode.",
        "Ban muon dung mon gi hom nay? Minh se goi y menu de ban chon nhanh.",
      ].join("\n"),
      getKeyboardByRole(msg.chat.id)
    );

    await sendMenu(msg.chat.id);
  }));

  bot.onText(/^\/help$/i, safe(async (msg) => {
    logCommand(msg.chat.id, "/help");
    if (isAdminChat(msg.chat.id)) {
      await sendAdminHelp(msg.chat.id);
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      [
        "Danh sach command:",
        "/start - Khoi dong bot",
        "/menu - Xem menu theo danh muc",
        "/add <item_code> <size> <quantity> - Them mon vao gio",
        '/add "<item_name>" <size> <quantity> - Them mon theo ten',
        "/cart - Xem gio hang",
        "/remove <line_number> - Xoa 1 dong trong gio",
        "/clearcart - Xoa toan bo gio hang",
        "/checkout - Bat dau quy trinh dat hang",
        "/confirm - Xac nhan dat don (khi dang checkout)",
        "/cod <orderCode> - Chon thanh toan COD",
        "/qr <orderCode> - Nhan link thanh toan QR PayOS",
        "/cancel - Huy checkout hien tai",
        "/ai <noi_dung> - Thu parser AI dat mon",
        "/mode - Xem thong tin che do",
        "",
        "Che do hien tai: AI-only",
        "Vi du: /add TS03 L 2",
        'Vi du: /add "Tra Sua Truyen Thong" L 2',
      ].join("\n"),
      getKeyboardByRole(msg.chat.id)
    );
  }));

  bot.onText(/^\/mode(?:\s+(list|ai))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const inputMode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/mode", inputMode);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    sessionService.setMode(chatId, MODES.AI);
    await bot.sendMessage(
      chatId,
      [
        "Bot chi ho tro AI mode.",
        "Ban cu nhap tu nhien de dat mon, xem gio, checkout.",
      ].join("\n"),
      getKeyboardByRole(chatId)
    );
  }));

  bot.onText(/^\/menu$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/menu");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    await sendMenu(chatId);
  }));

  bot.onText(/^\/add(?:\s+(.+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const addArgs = match && match[1] ? match[1] : "";
    logCommand(chatId, "/add", addArgs);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (!addArgs) {
      await bot.sendMessage(
        chatId,
        'Sai cu phap. Dung: /add <item_code> <size> <quantity> hoac /add "<item_name>" <size> <quantity>.\nVi du: /add TS03 L 2'
      );
      return;
    }

    const preValidation = validateAddCommand(addArgs);
    if (!preValidation.isValid) {
      await bot.sendMessage(chatId, preValidation.error);
      return;
    }

    const resolved = resolveMenuItemFromAddTarget(preValidation.target, preValidation.targetType);
    if (resolved.error) {
      await bot.sendMessage(chatId, resolved.error);
      return;
    }

    if (resolved.matches) {
      const options = resolved.matches
        .map((matchItem) => {
          return `${matchItem.item.itemId} - ${matchItem.item.name}`;
        })
        .join("\n");

      await bot.sendMessage(
        chatId,
        [
          "Tim thay nhieu mon gan dung, vui long chon lai bang item code:",
          options,
          `Vi du: /add ${resolved.matches[0].item.itemId} ${preValidation.size} ${preValidation.quantity}`,
        ].join("\n")
      );
      return;
    }

    const menuItem = resolved.item;
    const validation = validateAddCommand(addArgs, menuItem);

    if (!validation.isValid) {
      await bot.sendMessage(chatId, validation.error);
      return;
    }

    const cartItem = {
      itemId: menuItem.itemId,
      name: menuItem.name,
      category: menuItem.category,
      size: validation.size,
      quantity: validation.quantity,
      unitPrice: validation.unitPrice,
      baseUnitPrice: validation.unitPrice,
      toppingDetails: [],
      toppings: [],
      note: "",
    };

    cartService.addItem(chatId, cartItem);

    await bot.sendMessage(
      chatId,
      `Da them ${validation.quantity} ${menuItem.name} size ${validation.size} vao gio.`,
      getMainKeyboard()
    );
  }));

  bot.onText(/^\/cart$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/cart");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    await sendCart(chatId);
  }));

  bot.onText(/^\/remove(?:\s+(\d+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const lineText = match && match[1] ? match[1] : "";
    logCommand(chatId, "/remove", lineText);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (!lineText) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /remove <line_number>. Vi du: /remove 2");
      return;
    }

    const lineNumber = Number.parseInt(lineText, 10);
    const result = cartService.removeItemByLine(chatId, lineNumber);

    if (!result.ok) {
      await bot.sendMessage(chatId, result.error);
      return;
    }

    await bot.sendMessage(chatId, `Da xoa dong ${lineNumber}: ${result.removed.name}.`);
    await sendCart(chatId);
  }));

  bot.onText(/^\/qty(?:\s+(\d+))?(?:\s+(\d+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const lineText = match && match[1] ? match[1] : "";
    const quantityText = match && match[2] ? match[2] : "";
    logCommand(chatId, "/qty", `${lineText} ${quantityText}`.trim());

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (!lineText || !quantityText) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /qty <so_dong> <so_luong>. Vi du: /qty 1 3 (hoac /qty 1 0 de xoa)");
      return;
    }

    const lineNumber = Number.parseInt(lineText, 10);
    const quantity = Number.parseInt(quantityText, 10);
    const updated = cartService.updateItemQuantityByLine(chatId, lineNumber, quantity);

    if (!updated.ok) {
      await bot.sendMessage(chatId, updated.error);
      return;
    }

    if (updated.deleted && updated.removed) {
      await bot.sendMessage(chatId, `Da xoa dong ${lineNumber}: ${updated.removed.name}.`);
    } else {
      await bot.sendMessage(chatId, `Da cap nhat dong ${lineNumber}: ${updated.item.name} x ${updated.item.quantity}.`);
    }
    await sendCart(chatId);
  }));

  bot.onText(/^\/clearcart$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/clearcart");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    cartService.clearCart(chatId);
    await bot.sendMessage(chatId, "Da xoa toan bo gio hang.", getMainKeyboard());
  }));

  bot.onText(/^\/checkout$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/checkout");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    await startCheckout(chatId);
  }));

  bot.onText(/^\/cancel$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/cancel");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    const state = sessionService.getSession(chatId).state;

    if (state === STATES.IDLE) {
      await bot.sendMessage(chatId, "Khong co checkout nao dang dien ra.");
      return;
    }

    sessionService.resetSession(chatId);
    await bot.sendMessage(chatId, "Da huy quy trinh checkout hien tai.", getMainKeyboard());
  }));

  bot.onText(/^\/confirm$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/confirm");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    const session = sessionService.getSession(chatId);

    if (session.state !== STATES.CONFIRMING_ORDER) {
      await bot.sendMessage(chatId, "Ban chua o buoc xac nhan. Dung /checkout de bat dau.");
      return;
    }

    const cart = getCartOrEmpty(chatId);
    if (cart.items.length === 0) {
      sessionService.resetSession(chatId);
      await bot.sendMessage(chatId, "Giỏ hàng đang trống nên không thể tạo đơn.");
      return;
    }

    const data = session.data;
    sessionService.setState(chatId, STATES.WAITING_PAYMENT);

    const order = await orderService.createOrder({
      chatId,
      customerName: data.customerName,
      phone: data.phone,
      deliveryMethod: data.deliveryMethod,
      address: data.address || "",
      note: data.note || "",
      items: cart.items,
      totalAmount: cartService.getCartTotal(chatId),
      payment: null,
      paymentMethod: null,
    });

    logEvent("ORDER_CREATED", {
      orderCode: order.orderCode,
      chatId,
      totalAmount: order.totalAmount,
      itemCount: order.items.length,
    });

    cartService.clearCart(chatId);
    sessionService.resetSession(chatId);

    await notifyAdminNewOrder(order);

    const paymentOptions = paymentService.getPaymentOptions(order.orderCode);

    await bot.sendMessage(
      chatId,
      [
        "Dat hang thanh cong!",
        `Ma don: ${order.orderCode}`,
        `Tong tien: ${formatCurrencyVND(order.totalAmount)}`,
        `Trang thai don: ${order.status}`,
        `Trang thai thanh toan: ${order.paymentStatus}`,
        "",
        "Chon phuong thuc thanh toan (bấm nút):",
        ...paymentOptions.map((opt) => opt.label),
      ].join("\n"),
      buildPaymentMethodInlineKeyboard(order.orderCode)
    );
  }));

  bot.onText(/^\/orders$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/orders");

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    await sendAdminOrdersList(chatId, 0);
  }));

  bot.onText(/^\/order(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/order", orderCode);

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    if (!orderCode) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /order <orderCode>");
      return;
    }

    const order = await orderService.getOrderByCode(orderCode);
    if (!order) {
      await bot.sendMessage(chatId, `Khong tim thay don ${orderCode}.`);
      return;
    }

    const detail = buildAdminOrderDetail(order);
    await bot.sendMessage(chatId, detail, buildAdminOrderDetailKeyboard(order));
  }));

  bot.onText(/^\/cod(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/cod", orderCode);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (!orderCode) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /cod <orderCode>");
      return;
    }

    const order = await orderService.getOrderByCode(orderCode);
    if (!order) {
      await bot.sendMessage(chatId, `Khong tim thay don ${orderCode}.`);
      return;
    }

    if (!canManageOrder(chatId, order)) {
      await bot.sendMessage(chatId, "Ban khong co quyen thao tac don nay.");
      return;
    }

    const choice = paymentService.choosePaymentMethod(orderCode, paymentService.PAYMENT_METHODS.COD);
    if (!choice.ok) {
      await bot.sendMessage(chatId, choice.error);
      return;
    }

    await orderService.setPaymentMethod(orderCode, choice.paymentMethod);
    await bot.sendMessage(chatId, `Da chon COD cho don ${orderCode}.`);
  }));

  bot.onText(/^\/qr(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/qr", orderCode);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (!orderCode) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /qr <orderCode>");
      return;
    }

    const order = await orderService.getOrderByCode(orderCode);
    if (!order) {
      await bot.sendMessage(chatId, `Khong tim thay don ${orderCode}.`);
      return;
    }

    if (!canManageOrder(chatId, order)) {
      await bot.sendMessage(chatId, "Ban khong co quyen thao tac don nay.");
      return;
    }

    const choice = paymentService.choosePaymentMethod(orderCode, paymentService.PAYMENT_METHODS.QR);
    if (!choice.ok) {
      await bot.sendMessage(chatId, choice.error);
      return;
    }

    await orderService.setPaymentMethod(orderCode, choice.paymentMethod);
    let paymentLink;
    try {
      paymentLink = await paymentService.createPaymentLink(order);
      await orderService.saveOrderPayment(orderCode, paymentLink);
    } catch (error) {
      await bot.sendMessage(chatId, `Khong tao duoc link thanh toan PayOS: ${error.message}`);
      return;
    }

    await bot.sendMessage(
      chatId,
      buildPaymentLinkMessage(orderCode, paymentLink)
    );
  }));

  bot.onText(/^\/pay(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/pay", orderCode);

    await bot.sendMessage(
      chatId,
      "Lenh /pay da tat trong production. Vui long thanh toan qua QR PayOS de he thong tu cap nhat."
    );
  }));

  bot.onText(/^\/delivered(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/delivered", orderCode);

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    if (!orderCode) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /delivered <orderCode>");
      return;
    }

    const updated = await orderService.markOrderDelivered(orderCode);
    if (!updated) {
      await bot.sendMessage(chatId, `Khong tim thay don ${orderCode}.`);
      return;
    }

    await bot.sendMessage(chatId, `Da xac nhan don ${orderCode} da giao.`);
    if (String(updated.chatId) !== String(chatId)) {
      await bot.sendMessage(updated.chatId, `Don ${orderCode} cua ban da duoc giao thanh cong.`);
    }
  }));

  bot.onText(/^\/menuadmin$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/menuadmin");

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    await sendAdminMenu(chatId);
  }));

  bot.onText(/^\/menuadd(?:\s+(.+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const rawArgs = match && match[1] ? match[1] : "";
    logCommand(chatId, "/menuadd", rawArgs);

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    const parsed = parseMenuAddArgs(rawArgs);
    if (!parsed.ok) {
      await bot.sendMessage(chatId, parsed.error, getAdminKeyboard());
      return;
    }

    const created = menuService.addMenuItem(parsed.payload);
    if (!created.ok) {
      await bot.sendMessage(chatId, created.error, getAdminKeyboard());
      return;
    }

    try {
      await menuService.saveMenuToCsv();
    } catch (error) {
      await bot.sendMessage(chatId, `Da them mon nhung luu CSV that bai: ${error.message}`, getAdminKeyboard());
      return;
    }

    await bot.sendMessage(chatId, `Da them mon ${created.item.itemId} - ${created.item.name}.`, getAdminKeyboard());
  }));

  bot.onText(/^\/menuedit(?:\s+(.+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const rawArgs = match && match[1] ? match[1] : "";
    logCommand(chatId, "/menuedit", rawArgs);

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    const parsed = parseMenuEditArgs(rawArgs);
    if (!parsed.ok) {
      await bot.sendMessage(chatId, parsed.error, getAdminKeyboard());
      return;
    }

    const updated = menuService.updateMenuItem(parsed.itemId, parsed.updates);
    if (!updated.ok) {
      await bot.sendMessage(chatId, updated.error, getAdminKeyboard());
      return;
    }

    try {
      await menuService.saveMenuToCsv();
    } catch (error) {
      await bot.sendMessage(chatId, `Da sua mon nhung luu CSV that bai: ${error.message}`, getAdminKeyboard());
      return;
    }

    await bot.sendMessage(chatId, `Da cap nhat ${updated.item.itemId} - ${updated.item.name}.`, getAdminKeyboard());
  }));

  bot.onText(/^\/menudelete(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const itemId = match && match[1] ? match[1] : "";
    logCommand(chatId, "/menudelete", itemId);

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    if (!itemId) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /menudelete <item_id>", getAdminKeyboard());
      return;
    }

    const removed = menuService.removeMenuItem(itemId);
    if (!removed.ok) {
      await bot.sendMessage(chatId, removed.error, getAdminKeyboard());
      return;
    }

    try {
      await menuService.saveMenuToCsv();
    } catch (error) {
      await bot.sendMessage(chatId, `Da xoa mon nhung luu CSV that bai: ${error.message}`, getAdminKeyboard());
      return;
    }

    await bot.sendMessage(chatId, `Da xoa mon ${removed.item.itemId} - ${removed.item.name}.`, getAdminKeyboard());
  }));

  bot.onText(/^\/ai(?:\s+(.+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const content = match && match[1] ? match[1] : "";
    logCommand(chatId, "/ai", content);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (getChatMode(chatId) !== MODES.AI) {
      await bot.sendMessage(chatId, "Hien dang o che do LIST. Dung /mode ai de bat AI mode truoc.");
      return;
    }

    if (!content) {
      await bot.sendMessage(chatId, "Dung: /ai <noi_dung>. Vi du: /ai cho minh 2 tra sua truyen thong size L");
      return;
    }

    const consumed = await tryAddFromAi(chatId, content);
    if (!consumed) {
      await bot.sendMessage(chatId, "AI chua parse duoc yeu cau nay. Ban thu /add theo ma mon nhe.");
    }
  }));

  bot.on("callback_query", async (query) => {
    const chatId = query && query.message && query.message.chat ? query.message.chat.id : null;
    const data = String(query.data || "");
    const messageId = query && query.message ? query.message.message_id : null;

    if (!chatId || (!data.startsWith("lf:") && !data.startsWith("ad:") && !data.startsWith("pm:") && !data.startsWith("ct:"))) {
      return;
    }

    if (data.startsWith("ct:")) {
      if (isAdminChat(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: "Admin khong dung gio mua hang.", show_alert: false });
        return;
      }

      try {
        const parts = data.split(":");
        const action = parts[1] || "";
        const line = Number.parseInt(parts[2], 10);

        if (action === "noop") {
          await bot.answerCallbackQuery(query.id);
          return;
        }

        if (action === "refresh") {
          await bot.answerCallbackQuery(query.id, { text: "Da lam moi gio" });
          await sendCart(chatId);
          return;
        }

        if (action === "inc" || action === "dec") {
          const delta = action === "inc" ? 1 : -1;
          const updated = cartService.adjustItemQuantityByLine(chatId, line, delta);

          if (!updated.ok) {
            await bot.answerCallbackQuery(query.id, { text: updated.error, show_alert: true });
            return;
          }

          if (updated.deleted && updated.removed) {
            await bot.answerCallbackQuery(query.id, {
              text: `Da xoa ${updated.removed.name} khoi gio`,
            });
          } else {
            await bot.answerCallbackQuery(query.id, {
              text: `${updated.item.name} x ${updated.item.quantity}`,
            });
          }
          await sendCart(chatId);
          return;
        }

        await bot.answerCallbackQuery(query.id);
        return;
      } catch (error) {
        logEvent("CART_CALLBACK_ERROR", {
          chatId,
          data,
          message: error.message,
          stack: error.stack,
        });
        try {
          await bot.answerCallbackQuery(query.id, { text: "Da co loi, vui long thu lai." });
        } catch (callbackError) {
          logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: callbackError.message });
        }
        return;
      }
    }

    if (data.startsWith("pm:")) {
      try {
        const parts = data.split(":");
        const method = String(parts[1] || "").toLowerCase();
        const orderCode = String(parts[2] || "").toUpperCase();

        if (!orderCode) {
          await bot.answerCallbackQuery(query.id, { text: "Ma don khong hop le.", show_alert: true });
          return;
        }

        const order = await orderService.getOrderByCode(orderCode);
        if (!order) {
          await bot.answerCallbackQuery(query.id, { text: `Khong tim thay don ${orderCode}.`, show_alert: true });
          return;
        }

        if (!canManageOrder(chatId, order)) {
          await bot.answerCallbackQuery(query.id, { text: "Ban khong co quyen thao tac don nay.", show_alert: true });
          return;
        }

        if (method === "cod") {
          const choice = paymentService.choosePaymentMethod(orderCode, paymentService.PAYMENT_METHODS.COD);
          if (!choice.ok) {
            await bot.answerCallbackQuery(query.id, { text: choice.error, show_alert: true });
            return;
          }

          await orderService.setPaymentMethod(orderCode, choice.paymentMethod);
          await bot.answerCallbackQuery(query.id, { text: `Da chon COD cho ${orderCode}` });
          await bot.sendMessage(chatId, `Da chon COD cho don ${orderCode}.`);
          return;
        }

        if (method === "qr") {
          const choice = paymentService.choosePaymentMethod(orderCode, paymentService.PAYMENT_METHODS.QR);
          if (!choice.ok) {
            await bot.answerCallbackQuery(query.id, { text: choice.error, show_alert: true });
            return;
          }

          await orderService.setPaymentMethod(orderCode, choice.paymentMethod);
          let paymentLink;
          try {
            paymentLink = await paymentService.createPaymentLink(order);
            await orderService.saveOrderPayment(orderCode, paymentLink);
          } catch (error) {
            await bot.answerCallbackQuery(query.id, { text: "Khong tao duoc thanh toan", show_alert: true });
            await bot.sendMessage(chatId, `Khong tao duoc thanh toan PayOS: ${error.message}`);
            return;
          }

          await bot.answerCallbackQuery(query.id, { text: "Da tao link thanh toan PayOS" });
          await bot.sendMessage(chatId, buildPaymentLinkMessage(orderCode, paymentLink));
          return;
        }

        await bot.answerCallbackQuery(query.id);
        return;
      } catch (error) {
        logEvent("PAYMENT_CALLBACK_ERROR", {
          chatId,
          messageId,
          data,
          message: error.message,
          stack: error.stack,
        });

        try {
          await bot.answerCallbackQuery(query.id, { text: "Khong tao duoc thanh toan, vui long thu lai.", show_alert: true });
        } catch (answerError) {
          logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: answerError.message });
        }
        return;
      }
    }

    if (data.startsWith("ad:")) {
      if (!isAdminChat(chatId)) {
        try {
          await bot.answerCallbackQuery(query.id, { text: "Bạn không có quyền quản trị.", show_alert: true });
        } catch (error) {
          logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: error.message });
        }
        return;
      }

      try {
        const parts = data.split(":");
        const group = parts[1] || "";
        const action = parts[2] || "";

        if (group === "home") {
          await bot.answerCallbackQuery(query.id);
          await sendAdminDashboard(chatId);
          return;
        }

        if (group === "orders" && action === "list") {
          const page = Number.parseInt(parts[3], 10) || 0;
          await bot.answerCallbackQuery(query.id);
          await sendAdminOrdersList(chatId, page);
          return;
        }

        if (group === "orders" && action === "find") {
          await bot.answerCallbackQuery(query.id);
          saveAdminFlow(chatId, { action: "FIND_ORDER" });
          await bot.sendMessage(chatId, "Nhập mã đơn cần tìm (VD: ORDER0001)", getAdminKeyboard());
          return;
        }

        if (group === "order" && action === "view") {
          const orderCode = String(parts[3] || "").toUpperCase();
          await bot.answerCallbackQuery(query.id);
          await sendAdminOrderDetail(chatId, orderCode);
          return;
        }

        if (group === "order" && action === "delivered") {
          const orderCode = String(parts[3] || "").toUpperCase();
          const updated = await orderService.markOrderDelivered(orderCode);
          await bot.answerCallbackQuery(query.id);

          if (!updated) {
            await bot.sendMessage(chatId, `Không tìm thấy đơn ${orderCode}.`, getAdminKeyboard());
            return;
          }

          await bot.sendMessage(chatId, `Đã xác nhận đơn ${orderCode} đã giao.`, getAdminKeyboard());
          if (String(updated.chatId) !== String(chatId)) {
            await bot.sendMessage(updated.chatId, `Đơn ${orderCode} của bạn đã được giao thành công.`);
          }
          await sendAdminOrderDetail(chatId, orderCode);
          return;
        }

        if (group === "menu" && action === "list") {
          const page = Number.parseInt(parts[3], 10) || 0;
          await bot.answerCallbackQuery(query.id);
          await sendAdminMenuList(chatId, page);
          return;
        }

        if (group === "menu" && action === "view") {
          const itemId = parts[3] || "";
          await bot.answerCallbackQuery(query.id);
          await sendAdminMenuItemDetail(chatId, itemId);
          return;
        }

        if (group === "menu" && action === "toggle") {
          const itemId = parts[3] || "";
          const item = menuService.getItemByCode(itemId);
          await bot.answerCallbackQuery(query.id);

          if (!item) {
            await bot.sendMessage(chatId, `Không tìm thấy món ${itemId}.`, getAdminKeyboard());
            return;
          }

          const updated = menuService.updateMenuItem(itemId, { available: !item.available });
          if (!updated.ok) {
            await bot.sendMessage(chatId, `Không cập nhật được món: ${updated.error}`, getAdminKeyboard());
            return;
          }

          try {
            await menuService.saveMenuToCsv();
          } catch (error) {
            await bot.sendMessage(chatId, `Đã đổi trạng thái nhưng lưu CSV thất bại: ${error.message}`, getAdminKeyboard());
            return;
          }

          await sendAdminMenuItemDetail(chatId, itemId);
          return;
        }

        if (group === "menu" && action === "add") {
          await bot.answerCallbackQuery(query.id);
          saveAdminFlow(chatId, { action: "ADD_MENU", step: "itemId", draft: {} });
          await bot.sendMessage(chatId, "Nhập mã món mới (VD: TS20)", getAdminKeyboard());
          return;
        }

        if (group === "menu" && action === "edit") {
          const itemId = parts[4] || "";
          await bot.answerCallbackQuery(query.id);

          const item = menuService.getItemByCode(itemId);
          if (!item) {
            await bot.sendMessage(chatId, `Không tìm thấy món ${itemId}.`, getAdminKeyboard());
            return;
          }

          await bot.sendMessage(
            chatId,
            `Chọn trường cần sửa cho ${item.itemId} - ${item.name}`,
            buildAdminMenuEditFieldKeyboard(item.itemId)
          );
          return;
        }

        if (group === "menu" && action === "editfield") {
          const itemId = parts[3] || "";
          const field = parts[4] || "";
          await bot.answerCallbackQuery(query.id);

          const validFields = ["name", "category", "priceM", "priceL", "description", "available"];
          if (!validFields.includes(field)) {
            await bot.sendMessage(chatId, "Trường sửa không hợp lệ.", getAdminKeyboard());
            return;
          }

          saveAdminFlow(chatId, { action: "EDIT_MENU_FIELD", itemId, field });
          await bot.sendMessage(chatId, `Nhập giá trị mới cho ${field}:`, getAdminKeyboard());
          return;
        }

        if (group === "menu" && action === "delete") {
          const subAction = parts[3] || "";
          const itemId = parts[4] || "";

          if (subAction === "confirm") {
            await bot.answerCallbackQuery(query.id);
            await bot.sendMessage(
              chatId,
              `Bạn có chắc muốn xóa món ${itemId}?`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "✅ Xóa", callback_data: `ad:menu:delete:do:${itemId}` },
                      { text: "❌ Hủy", callback_data: `ad:menu:view:${itemId}` },
                    ],
                  ],
                },
              }
            );
            return;
          }

          if (subAction === "do") {
            await bot.answerCallbackQuery(query.id);
            const removed = menuService.removeMenuItem(itemId);
            if (!removed.ok) {
              await bot.sendMessage(chatId, removed.error, getAdminKeyboard());
              return;
            }

            try {
              await menuService.saveMenuToCsv();
            } catch (error) {
              await bot.sendMessage(chatId, `Đã xóa món nhưng lưu CSV thất bại: ${error.message}`, getAdminKeyboard());
              return;
            }

            await bot.sendMessage(chatId, `Đã xóa món ${itemId}.`, getAdminKeyboard());
            await sendAdminMenuList(chatId, 0);
            return;
          }
        }

        await bot.answerCallbackQuery(query.id);
        return;
      } catch (error) {
        logEvent("ADMIN_CALLBACK_ERROR", {
          chatId,
          messageId,
          data,
          message: error.message,
          stack: error.stack,
        });
        try {
          await bot.answerCallbackQuery(query.id, { text: "Đã có lỗi, vui lòng thử lại." });
        } catch (answerError) {
          logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: answerError.message });
        }
        await bot.sendMessage(chatId, "Có lỗi khi xử lý thao tác admin.", getAdminKeyboard());
        return;
      }
    }

    if (isAdminChat(chatId)) {
      try {
        await bot.answerCallbackQuery(query.id, {
          text: "Admin khong dung luong dat hang.",
          show_alert: false,
        });
      } catch (error) {
        logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: error.message });
      }

      await bot.sendMessage(
        chatId,
        "Tai khoan admin chi quan ly don/menu. Dung /help de xem lenh quan tri.",
        getAdminKeyboard()
      );
      return;
    }

    try {
      const parts = data.split(":");
      const action = parts[1] || "";

      if (data.startsWith("lf:")) {
        if (action === "cart") {
          await bot.answerCallbackQuery(query.id);
          await sendCart(chatId);
          return;
        }

        if (action === "checkout") {
          await bot.answerCallbackQuery(query.id);
          await startCheckout(chatId);
          return;
        }

        await bot.answerCallbackQuery(query.id, { text: "LIST mode đã tắt. Bạn nhập tự nhiên để đặt món AI nhé." });
        return;
      }

      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      logEvent("CALLBACK_ERROR", {
        chatId,
        data,
        message: error.message,
        stack: error.stack,
      });

      if (query && query.id) {
        try {
          await bot.answerCallbackQuery(query.id, { text: "Da co loi, vui long thu lai." });
        } catch (callbackError) {
          logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: callbackError.message });
        }
      }

      await bot.sendMessage(chatId, "Đã có lỗi xảy ra, bạn thử lại giúp mình nhé.");
    }
  });

  bot.on("message", safe(async (msg) => {
    const chatId = msg.chat.id;
    const text = String(msg.text || "").trim();

    if (!text) {
      return;
    }

    if (isAdminChat(chatId)) {
      if (text === "Đơn hàng") {
        await sendAdminOrdersList(chatId, 0);
        return;
      }

      if (text === "Menu quản lý") {
        await sendAdminMenuList(chatId, 0);
        return;
      }

      if (text === "Thêm món mới") {
        saveAdminFlow(chatId, { action: "ADD_MENU", step: "itemId", draft: {} });
        await bot.sendMessage(chatId, "Nhập mã món mới (VD: TS20)", getAdminKeyboard());
        return;
      }

      if (text === "Tìm đơn hàng") {
        saveAdminFlow(chatId, { action: "FIND_ORDER" });
        await bot.sendMessage(chatId, "Nhập mã đơn cần tìm (VD: ORDER0001)", getAdminKeyboard());
        return;
      }

      if (text === "Hướng dẫn admin") {
        await sendAdminHelp(chatId);
        return;
      }

      const consumedByAdminFlow = await handleAdminFlowInput(chatId, text);
      if (consumedByAdminFlow) {
        return;
      }
    }

    if (isAdminChat(chatId) && ["Xem menu", "Xem giỏ hàng", "Checkout", "Chế độ AI"].includes(text)) {
      await denyBuyerFlowForAdmin(chatId);
      return;
    }

    if (isAdminChat(chatId) && text === "Chọn món khác") {
      await denyBuyerFlowForAdmin(chatId);
      return;
    }

    if (text === "Xem menu") {
      await sendMenu(chatId);
      return;
    }

    if (text === "Chọn món khác") {
      await sendMenu(chatId);
      return;
    }

    if (text === "Xem đơn hàng") {
      if (!isAdminChat(chatId)) {
        await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
        return;
      }

      await sendAdminOrdersList(chatId, 0);
      return;
    }

    if (text === "Xem menu admin") {
      if (!isAdminChat(chatId)) {
        await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
        return;
      }

      await sendAdminMenuList(chatId, 0);
      return;
    }

    if (text === "Hướng dẫn admin") {
      if (!isAdminChat(chatId)) {
        await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
        return;
      }

      await sendAdminHelp(chatId);
      return;
    }

    if (text === "Xem giỏ hàng") {
      await sendCart(chatId);
      return;
    }

    if (text === "Checkout") {
      await startCheckout(chatId);
      return;
    }

    if (text === "Chế độ AI") {
      sessionService.setMode(chatId, MODES.AI);
      await bot.sendMessage(
        chatId,
        "Đã chuyển sang chế độ AI. Bạn có thể nhập tự nhiên để bot parse.",
        getKeyboardByRole(chatId)
      );
      return;
    }

    const normalizedInput = menuService.normalizeText(text);
    if (["ve list", "qua list", "che do list", "mode list", "dat bang nut", "nut bam"].includes(normalizedInput)) {
      await bot.sendMessage(chatId, "Bot chỉ hỗ trợ AI mode. Bạn cứ nhắn tự nhiên để mình xử lý nhé.", getKeyboardByRole(chatId));
      return;
    }

    if (["ve ai", "qua ai", "che do ai", "mode ai", "chat tu nhien", "nhap tu nhien"].includes(normalizedInput)) {
      sessionService.setMode(chatId, MODES.AI);

      await bot.sendMessage(
        chatId,
        "Đã chuyển sang chế độ AI. Bạn có thể nhập tự nhiên để bot parse.",
        getKeyboardByRole(chatId)
      );
      return;
    }

    if (text.startsWith("/")) {
      return;
    }

    if (isAdminChat(chatId)) {
      await bot.sendMessage(
        chatId,
        "Admin chi dung chuc nang quan tri. Dung /help de xem cac lenh quan tri.",
        getAdminKeyboard()
      );
      return;
    }

    if (getChatMode(chatId) !== MODES.AI) {
      sessionService.setMode(chatId, MODES.AI);
    }

    if (getChatMode(chatId) === MODES.AI) {
      const consumedPending = await handlePendingAiAddInput(chatId, text);
      if (consumedPending) {
        return;
      }
    }

    const state = sessionService.getSession(chatId).state;
    if (state !== STATES.IDLE) {
      await handleCheckoutStateMessage(chatId, text);
      return;
    }

    const consumedByAi = await tryAddFromAi(chatId, text);
    if (consumedByAi) {
      return;
    }

    await bot.sendMessage(chatId, "Mình chưa hiểu ý bạn. Dùng /help để xem lệnh hỗ trợ nhé.", getKeyboardByRole(chatId));
  }));
}

module.exports = {
  setupBotHandlers,
};
