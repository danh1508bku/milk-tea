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
        ["Chế độ LIST", "Chế độ AI"],
      ],
      resize_keyboard: true,
    },
  };
}

function getAdminKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["Xem đơn hàng", "Xem menu admin"],
        ["Hướng dẫn admin"],
      ],
      resize_keyboard: true,
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

function getModeInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Chế độ LIST", callback_data: "lf:mode:LIST" },
          { text: "Chế độ AI", callback_data: "lf:mode:AI" },
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

  function getKeyboardByRole(chatId) {
    return isAdminChat(chatId) ? getAdminKeyboard() : getMainKeyboard();
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

  function getAvailableDrinkItems() {
    return menuService
      .getMenu()
      .filter((item) => item.available && item.category !== "Topping");
  }

  function getAvailableToppings() {
    return menuService
      .getMenu()
      .filter((item) => item.available && item.category === "Topping");
  }

  function shortButtonLabel(item) {
    const maxLen = 20;
    const name = String(item.name || "");
    const shortName = name.length > maxLen ? `${name.slice(0, maxLen - 1)}…` : name;
    return `${item.itemId} | ${shortName}`;
  }

  function buildListMenuKeyboard() {
    const items = getAvailableDrinkItems();
    const rows = [];

    for (let i = 0; i < items.length; i += 2) {
      const left = items[i];
      const right = items[i + 1];
      const row = [{ text: shortButtonLabel(left), callback_data: `lf:item:${left.itemId}` }];
      if (right) {
        row.push({ text: shortButtonLabel(right), callback_data: `lf:item:${right.itemId}` });
      }
      rows.push(row);
    }

    rows.push([{ text: "Xem giỏ hàng", callback_data: "lf:cart" }]);
    rows.push([{ text: "Chọn mode", callback_data: "lf:modepicker" }]);

    return {
      reply_markup: {
        inline_keyboard: rows,
      },
    };
  }

  function buildItemActionKeyboard(itemId) {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Xem mô tả", callback_data: `lf:desc:${itemId}` },
            { text: "Xem giá", callback_data: `lf:price:${itemId}` },
          ],
          [
            { text: "Chọn size M", callback_data: `lf:size:${itemId}:M` },
            { text: "Chọn size L", callback_data: `lf:size:${itemId}:L` },
          ],
          [{ text: "⬅ Danh sách sản phẩm", callback_data: "lf:list" }],
        ],
      },
    };
  }

  function buildQuantityKeyboard(itemId, size) {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "1", callback_data: `lf:qty:${itemId}:${size}:1` },
            { text: "2", callback_data: `lf:qty:${itemId}:${size}:2` },
            { text: "3", callback_data: `lf:qty:${itemId}:${size}:3` },
            { text: "Số khác", callback_data: `lf:qtycustom:${itemId}:${size}` },
          ],
          [{ text: "⬅ Chọn lại sản phẩm", callback_data: `lf:item:${itemId}` }],
        ],
      },
    };
  }

  function buildToppingKeyboard(selectedCodes = []) {
    const toppings = getAvailableToppings();
    const rows = [];

    for (let i = 0; i < toppings.length; i += 2) {
      const row = [];
      const left = toppings[i];
      const right = toppings[i + 1];
      const leftSelected = selectedCodes.includes(left.itemId) ? "✅ " : "";
      row.push({
        text: `${leftSelected}${left.name} (+${formatCurrencyVND(left.priceM)})`,
        callback_data: `lf:top:${left.itemId}`,
      });

      if (right) {
        const rightSelected = selectedCodes.includes(right.itemId) ? "✅ " : "";
        row.push({
          text: `${rightSelected}${right.name} (+${formatCurrencyVND(right.priceM)})`,
          callback_data: `lf:top:${right.itemId}`,
        });
      }

      rows.push(row);
    }

    rows.push([
      { text: "Bỏ qua topping", callback_data: "lf:topskip" },
      { text: "Xong topping", callback_data: "lf:topdone" },
    ]);
    rows.push([{ text: "⬅ Chọn lại số lượng", callback_data: "lf:qtyback" }]);

    return {
      reply_markup: {
        inline_keyboard: rows,
      },
    };
  }

  function buildPostAddKeyboard() {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Chọn món khác", callback_data: "lf:list" }],
          [
            { text: "Xem giỏ hàng", callback_data: "lf:cart" },
            { text: "Checkout", callback_data: "lf:checkout" },
          ],
        ],
      },
    };
  }

  function getListFlow(chatId) {
    const session = sessionService.getSession(chatId);
    return session.data && session.data.listFlow ? session.data.listFlow : null;
  }

  function saveListFlow(chatId, flowData) {
    const current = getListFlow(chatId) || {};
    sessionService.mergeData(chatId, {
      listFlow: {
        ...current,
        ...flowData,
      },
    });
  }

  function clearListFlow(chatId) {
    sessionService.mergeData(chatId, { listFlow: null });
  }

  async function sendModePicker(chatId, title = "Chọn mode hoạt động:") {
    await bot.sendMessage(chatId, title, getModeInlineKeyboard());
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
      ].join("\n"),
      getAdminKeyboard()
    );
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

  async function sendListMenu(chatId) {
    clearListFlow(chatId);
    await bot.sendMessage(
      chatId,
      "LIST MODE: Chọn sản phẩm bằng nút bên dưới. Sau đó bot sẽ dẫn bạn chọn size, số lượng và topping.",
      buildListMenuKeyboard()
    );
  }

  async function sendItemActions(chatId, itemId) {
    const item = menuService.getItemByCode(itemId);
    if (!item || item.category === "Topping") {
      await bot.sendMessage(chatId, "Sản phẩm không hợp lệ, vui lòng chọn lại từ danh sách.", buildListMenuKeyboard());
      return;
    }

    saveListFlow(chatId, {
      itemId: item.itemId,
      size: null,
      quantity: null,
      selectedToppings: [],
    });

    await bot.sendMessage(
      chatId,
      [
        `Bạn chọn: ${item.name}`,
        "Bấm Xem mô tả / Xem giá hoặc chọn size trực tiếp.",
      ].join("\n"),
      buildItemActionKeyboard(item.itemId)
    );
  }

  async function sendToppingSelection(chatId, messageId) {
    const flow = getListFlow(chatId);
    if (!flow || !flow.itemId || !flow.size || !flow.quantity) {
      await bot.sendMessage(chatId, "Thiếu thông tin chọn món. Vui lòng bắt đầu lại từ danh sách.", buildListMenuKeyboard());
      return;
    }

    const item = menuService.getItemByCode(flow.itemId);
    if (!item) {
      await bot.sendMessage(chatId, "Không tìm thấy món đã chọn. Vui lòng chọn lại.", buildListMenuKeyboard());
      return;
    }

    const chosenToppings = (flow.selectedToppings || [])
      .map((code) => menuService.getItemByCode(code))
      .filter(Boolean)
      .map((top) => top.name);

    const toppingLine = chosenToppings.length > 0 ? chosenToppings.join(", ") : "Chưa chọn";
    const text = [
      `Món: ${item.name}`,
      `Size: ${flow.size}`,
      `Số lượng: ${flow.quantity}`,
      `Topping đã chọn: ${toppingLine}`,
      "Bấm topping để bật/tắt, rồi chọn Xong topping.",
    ].join("\n");

    const keyboard = buildToppingKeyboard(flow.selectedToppings || []);

    if (messageId) {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: keyboard.reply_markup,
        });
        return;
      } catch (error) {
        logEvent("EDIT_TOPPING_MESSAGE_FAILED", { chatId, reason: error.message });
      }
    }

    await bot.sendMessage(chatId, text, keyboard);
  }

  async function finalizeListSelection(chatId, skipTopping = false) {
    const flow = getListFlow(chatId);
    if (!flow || !flow.itemId || !flow.size || !flow.quantity) {
      await bot.sendMessage(chatId, "Thiếu dữ liệu món đã chọn. Vui lòng chọn lại từ danh sách.", buildListMenuKeyboard());
      return;
    }

    const menuItem = menuService.getItemByCode(flow.itemId);
    if (!menuItem) {
      await bot.sendMessage(chatId, "Món không còn trong menu. Vui lòng chọn món khác.", buildListMenuKeyboard());
      return;
    }

    const size = String(flow.size).toUpperCase() === "L" ? "L" : "M";
    const quantity = Number.parseInt(flow.quantity, 10);
    const chosenCodes = skipTopping ? [] : Array.from(new Set(flow.selectedToppings || []));
    const chosenToppings = chosenCodes
      .map((code) => menuService.getItemByCode(code))
      .filter((item) => item && item.category === "Topping");

    const baseUnitPrice = size === "L" ? menuItem.priceL : menuItem.priceM;
    const toppingUnitPrice = chosenToppings.reduce((sum, top) => sum + Number(top.priceM || 0), 0);
    const unitPrice = baseUnitPrice + toppingUnitPrice;

    cartService.addItem(chatId, {
      itemId: menuItem.itemId,
      name: menuItem.name,
      category: menuItem.category,
      size,
      quantity,
      unitPrice,
      baseUnitPrice,
      toppingDetails: chosenToppings.map((top) => ({
        itemId: top.itemId,
        name: top.name,
        unitPrice: Number(top.priceM || 0),
      })),
      toppings: chosenToppings.map((top) => top.name),
      note: "",
    });

    clearListFlow(chatId);

    const toppingText = chosenToppings.length > 0 ? chosenToppings.map((top) => top.name).join(", ") : "Không";
    await bot.sendMessage(
      chatId,
      [
        `Đã thêm ${quantity} ${menuItem.name} size ${size} vào giỏ.`,
        `Topping: ${toppingText}`,
        `Đơn giá tính tiền: ${formatCurrencyVND(unitPrice)}`,
      ].join("\n"),
      buildPostAddKeyboard()
    );
  }

  async function sendMenu(chatId) {
    if (getChatMode(chatId) === MODES.LIST) {
      await sendListMenu(chatId);
      return;
    }

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
      `SĐT: ${maskPhone(order.phone)}`,
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

  async function tryAddFromAi(chatId, text) {
    if (!llmService) {
      return false;
    }

    const parsed = await llmService.parseOrderMessage(text, menuService.getMenu());
    if (!parsed || parsed.intent !== "add_to_cart" || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      return false;
    }

    const itemDraft = parsed.items[0];
    const rawTarget = itemDraft.itemId || itemDraft.itemName;
    const size = String(itemDraft.size || "").toUpperCase();
    const quantity = Number.parseInt(itemDraft.quantity, 10);

    if (!rawTarget) {
      await bot.sendMessage(chatId, "Mình chưa xác định được món bạn muốn đặt. Bạn thử nói rõ hơn hoặc dùng /menu.");
      return true;
    }

    const targetType = menuService.getItemByCode(rawTarget) ? "code_or_name" : "code_or_name";
    const resolved = resolveMenuItemFromAddTarget(rawTarget, targetType);

    if (resolved.error || resolved.matches) {
      await bot.sendMessage(chatId, "Mình chưa chắc món bạn chọn. Bạn dùng /add theo item code để chính xác hơn nhé.");
      return true;
    }

    const addCommand = `${resolved.item.itemId} ${size || "M"} ${Number.isInteger(quantity) && quantity > 0 ? quantity : 1}`;
    const validation = validateAddCommand(addCommand, resolved.item);
    if (!validation.isValid) {
      await bot.sendMessage(chatId, `Mình đã hiểu ý nhưng thiếu thông tin: ${parsed.missingFields.join(", ")}.`);
      return true;
    }

    cartService.addItem(chatId, {
      itemId: resolved.item.itemId,
      name: resolved.item.name,
      category: resolved.item.category,
      size: validation.size,
      quantity: validation.quantity,
      unitPrice: validation.unitPrice,
      baseUnitPrice: validation.unitPrice,
      toppingDetails: [],
      toppings: [],
      note: "",
    });

    await bot.sendMessage(
      chatId,
      `AI da them ${validation.quantity} ${resolved.item.name} size ${validation.size} vao gio.`,
      getMainKeyboard()
    );
    return true;
  }

  async function sendCart(chatId) {
    const cart = getCartOrEmpty(chatId);
    const message = buildCartMessage(cart);
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
        await bot.sendMessage(chatId, "Chon hinh thuc nhan hang: pickup hoac delivery");
        return;
      }

      case STATES.WAITING_DELIVERY_METHOD: {
        const deliveryMethod = normalizeDeliveryMethod(text);
        if (!deliveryMethod) {
          await bot.sendMessage(chatId, "Chi chap nhan pickup hoac delivery. Vui long nhap lai.");
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
    const mode = getChatMode(msg.chat.id);

    if (isAdmin) {
      await bot.sendMessage(
        msg.chat.id,
        [
          "Chao admin.",
          "Ban dang o giao dien quan ly don/menu.",
          "Nhan 'Huong dan admin' hoac dung /help de xem lenh.",
        ].join("\n"),
        getAdminKeyboard()
      );
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      [
        "Chao ban, minh la bot dat tra sua.",
        `Che do hien tai: ${mode}`,
        "- LIST: chi dat theo menu co san",
        "- AI: nhap ngon ngu tu nhien de bot parse",
        "Bam nut Chon mode ben duoi hoac dung /mode list, /mode ai.",
      ].join("\n"),
      getKeyboardByRole(msg.chat.id)
    );

    await sendModePicker(msg.chat.id);
  }));

  bot.onText(/^\/help$/i, safe(async (msg) => {
    logCommand(msg.chat.id, "/help");
    if (isAdminChat(msg.chat.id)) {
      await sendAdminHelp(msg.chat.id);
      return;
    }

    const mode = getChatMode(msg.chat.id);
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
        "/qr <orderCode> - Nhan link QR mock",
        "/pay <orderCode> - Gia lap thanh toan thanh cong",
        "/cancel - Huy checkout hien tai",
        "/ai <noi_dung> - Thu parser AI dat mon",
        "/mode - Xem che do hien tai",
        "/mode list - Ve che do dat theo danh sach",
        "/mode ai - Bat che do dat bang ngon ngu tu nhien",
        "",
        `Che do hien tai: ${mode}`,
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

    if (!inputMode) {
      const currentMode = getChatMode(chatId);
      await sendModePicker(
        chatId,
        [
          `Che do hien tai: ${currentMode}`,
          "Dung /mode list de dat theo menu co san.",
          "Dung /mode ai de dat bang ngon ngu tu nhien.",
        ].join("\n")
      );
      return;
    }

    const nextMode = inputMode === "AI" ? MODES.AI : MODES.LIST;
    const result = sessionService.setMode(chatId, nextMode);
    if (!result.ok) {
      await bot.sendMessage(chatId, result.error);
      return;
    }

    if (result.mode === MODES.AI) {
      await bot.sendMessage(
        chatId,
        [
          "Da chuyen sang che do AI.",
          "Ban co the nhap tu nhien, vi du: cho minh 2 tra sua truyen thong size L",
        ].join("\n")
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      [
        "Da chuyen sang che do LIST.",
        "Ban dat hang bang nut bam, khong can go /add.",
      ].join("\n")
    );

    await sendListMenu(chatId);
  }));

  bot.onText(/^\/menu$/i, safe(async (msg) => {
    logCommand(msg.chat.id, "/menu");
    await sendMenu(msg.chat.id);
  }));

  bot.onText(/^\/add(?:\s+(.+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const addArgs = match && match[1] ? match[1] : "";
    logCommand(chatId, "/add", addArgs);

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
    logCommand(msg.chat.id, "/cart");
    await sendCart(msg.chat.id);
  }));

  bot.onText(/^\/remove(?:\s+(\d+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const lineText = match && match[1] ? match[1] : "";
    logCommand(chatId, "/remove", lineText);

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

  bot.onText(/^\/clearcart$/i, safe(async (msg) => {
    logCommand(msg.chat.id, "/clearcart");
    cartService.clearCart(msg.chat.id);
    await bot.sendMessage(msg.chat.id, "Da xoa toan bo gio hang.", getMainKeyboard());
  }));

  bot.onText(/^\/checkout$/i, safe(async (msg) => {
    logCommand(msg.chat.id, "/checkout");
    await startCheckout(msg.chat.id);
  }));

  bot.onText(/^\/cancel$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/cancel");
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
        "Chon phuong thuc thanh toan:",
        ...paymentOptions.map((opt) => opt.label),
        `Sau khi QR thanh cong, nhap /pay ${order.orderCode}`,
      ].join("\n"),
      getMainKeyboard()
    );
  }));

  bot.onText(/^\/orders$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/orders");

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    const orders = await orderService.listOrders();
    if (orders.length === 0) {
      await bot.sendMessage(chatId, "Chua co don hang nao", getAdminKeyboard());
      return;
    }

    const lines = orders.map((order) => formatAdminOrderLine(order));
    await bot.sendMessage(chatId, lines.join("\n"), getAdminKeyboard());
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
    await bot.sendMessage(chatId, detail, getAdminKeyboard());
  }));

  bot.onText(/^\/cod(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/cod", orderCode);

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
    const paymentLink = await paymentService.createPaymentLink(order);
    await orderService.saveOrderPayment(orderCode, paymentLink);

    await bot.sendMessage(
      chatId,
      [
        `Link thanh toan QR cho don ${orderCode}:`,
        paymentLink.paymentUrl || paymentLink.checkoutUrl,
        `Sau khi thanh toan xong, nhap /pay ${orderCode}`,
      ].join("\n")
    );
  }));

  bot.onText(/^\/pay(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/pay", orderCode);

    if (!orderCode) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /pay <orderCode>");
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

    const updated = await orderService.updateOrderPayment(orderCode, orderService.PAYMENT_STATUS.PAID);
    if (!updated) {
      await bot.sendMessage(chatId, `Khong cap nhat duoc thanh toan cho ${orderCode}.`);
      return;
    }

    await bot.sendMessage(chatId, `Thanh toan thanh cong cho don ${orderCode}.`);

    if (adminChatId && String(chatId) !== String(adminChatId)) {
      await bot.sendMessage(adminChatId, `Don ${orderCode} da thanh toan thanh cong.`);
    }
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

    if (!chatId || !data.startsWith("lf:")) {
      return;
    }

    try {
      const parts = data.split(":");
      const action = parts[1] || "";

      if (action === "modepicker") {
        await bot.answerCallbackQuery(query.id);
        await sendModePicker(chatId);
        return;
      }

      if (action === "mode") {
        const nextMode = String(parts[2] || "").toUpperCase();
        const result = sessionService.setMode(chatId, nextMode);

        if (!result.ok) {
          await bot.answerCallbackQuery(query.id, { text: result.error, show_alert: true });
          return;
        }

        await bot.answerCallbackQuery(query.id, { text: `Da chuyen sang ${result.mode}` });

        if (result.mode === MODES.LIST) {
          await sendListMenu(chatId);
          return;
        }

        await bot.sendMessage(chatId, "Da chuyen sang che do AI. Ban co the nhap tu nhien de bot parse.", getMainKeyboard());
        return;
      }

      if (getChatMode(chatId) !== MODES.LIST) {
        await bot.answerCallbackQuery(query.id, { text: "Vui long chuyen sang LIST mode de dung cac nut nay." });
        return;
      }

      if (action === "list") {
        await bot.answerCallbackQuery(query.id);
        await sendListMenu(chatId);
        return;
      }

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

      if (action === "item") {
        const itemId = parts[2];
        await bot.answerCallbackQuery(query.id);
        await sendItemActions(chatId, itemId);
        return;
      }

      if (action === "desc") {
        const itemId = parts[2];
        const item = menuService.getItemByCode(itemId);
        await bot.answerCallbackQuery(query.id, {
          text: item ? item.description : "Khong tim thay mo ta.",
          show_alert: true,
        });
        return;
      }

      if (action === "price") {
        const itemId = parts[2];
        const item = menuService.getItemByCode(itemId);
        await bot.answerCallbackQuery(query.id, {
          text: item
            ? `Gia ${item.name}\nM: ${formatCurrencyVND(item.priceM)}\nL: ${formatCurrencyVND(item.priceL)}`
            : "Khong tim thay gia.",
          show_alert: true,
        });
        return;
      }

      if (action === "size") {
        const itemId = parts[2];
        const size = String(parts[3] || "M").toUpperCase() === "L" ? "L" : "M";
        const item = menuService.getItemByCode(itemId);

        if (!item) {
          await bot.answerCallbackQuery(query.id, { text: "Mon khong hop le.", show_alert: true });
          return;
        }

        saveListFlow(chatId, {
          itemId: item.itemId,
          size,
          quantity: null,
          selectedToppings: [],
        });

        await bot.answerCallbackQuery(query.id, { text: `Da chon size ${size}` });
        await bot.sendMessage(
          chatId,
          `Da chon ${item.name} size ${size}. Bam so luong mong muon:`,
          buildQuantityKeyboard(item.itemId, size)
        );
        return;
      }

      if (action === "qty") {
        const itemId = parts[2];
        const size = String(parts[3] || "M").toUpperCase() === "L" ? "L" : "M";
        const quantity = Number.parseInt(parts[4], 10);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          await bot.answerCallbackQuery(query.id, { text: "So luong khong hop le.", show_alert: true });
          return;
        }

        saveListFlow(chatId, {
          itemId,
          size,
          quantity,
          selectedToppings: [],
        });

        await bot.answerCallbackQuery(query.id, { text: `Da chon so luong ${quantity}` });
        await sendToppingSelection(chatId);
        return;
      }

      if (action === "qtycustom") {
        const itemId = parts[2];
        const size = String(parts[3] || "M").toUpperCase() === "L" ? "L" : "M";
        const item = menuService.getItemByCode(itemId);

        if (!item) {
          await bot.answerCallbackQuery(query.id, { text: "Mon khong hop le.", show_alert: true });
          return;
        }

        saveListFlow(chatId, {
          itemId,
          size,
          quantity: null,
          selectedToppings: [],
          waitingCustomQuantity: true,
        });

        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(
          chatId,
          `Bạn đã chọn ${item.name} size ${size}.\nVui lòng nhập số lượng mong muốn (số nguyên > 0).`
        );
        return;
      }

      if (action === "qtyback") {
        const flow = getListFlow(chatId);
        if (!flow || !flow.itemId || !flow.size) {
          await bot.answerCallbackQuery(query.id, { text: "Khong tim thay buoc truoc." });
          await sendListMenu(chatId);
          return;
        }

        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(
          chatId,
          `Ban dang chon ${flow.itemId} size ${flow.size}. Bam lai so luong:`,
          buildQuantityKeyboard(flow.itemId, flow.size)
        );
        return;
      }

      if (action === "top") {
        const toppingId = parts[2];
        const flow = getListFlow(chatId);

        if (!flow || !flow.itemId || !flow.size || !flow.quantity) {
          await bot.answerCallbackQuery(query.id, { text: "Ban chua chon du thong tin mon." });
          await sendListMenu(chatId);
          return;
        }

        const exists = menuService.getItemByCode(toppingId);
        if (!exists || exists.category !== "Topping") {
          await bot.answerCallbackQuery(query.id, { text: "Topping khong hop le." });
          return;
        }

        const selected = new Set(flow.selectedToppings || []);
        if (selected.has(toppingId)) {
          selected.delete(toppingId);
        } else {
          selected.add(toppingId);
        }

        saveListFlow(chatId, { selectedToppings: Array.from(selected) });
        await bot.answerCallbackQuery(query.id);
        await sendToppingSelection(chatId, query.message.message_id);
        return;
      }

      if (action === "topskip") {
        await bot.answerCallbackQuery(query.id, { text: "Bo qua topping" });
        await finalizeListSelection(chatId, true);
        return;
      }

      if (action === "topdone") {
        await bot.answerCallbackQuery(query.id, { text: "Da chot topping, dang them vao gio" });
        await finalizeListSelection(chatId, false);
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

    if (text === "Xem menu") {
      await sendMenu(chatId);
      return;
    }

    if (text === "Xem đơn hàng") {
      if (!isAdminChat(chatId)) {
        await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
        return;
      }

      const orders = await orderService.listOrders();
      if (!orders.length) {
        await bot.sendMessage(chatId, "Chua co don hang nao", getAdminKeyboard());
        return;
      }

      await bot.sendMessage(chatId, orders.map((order) => formatAdminOrderLine(order)).join("\n"), getAdminKeyboard());
      return;
    }

    if (text === "Xem menu admin") {
      if (!isAdminChat(chatId)) {
        await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
        return;
      }

      await sendAdminMenu(chatId);
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

    if (text === "Chế độ LIST") {
      const result = sessionService.setMode(chatId, MODES.LIST);
      if (!result.ok) {
        await bot.sendMessage(chatId, result.error, getMainKeyboard());
        return;
      }

      await bot.sendMessage(
        chatId,
        "Đã chuyển sang chế độ LIST. Mình sẽ dẫn bạn chọn món theo từng bước bằng nút bấm.",
        getKeyboardByRole(chatId)
      );
      await sendListMenu(chatId);
      return;
    }

    if (text === "Chế độ AI") {
      const result = sessionService.setMode(chatId, MODES.AI);
      if (!result.ok) {
        await bot.sendMessage(chatId, result.error, getMainKeyboard());
        return;
      }

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

    const listFlow = getListFlow(chatId);
    if (getChatMode(chatId) === MODES.LIST && listFlow && listFlow.waitingCustomQuantity) {
      const quantity = Number.parseInt(text, 10);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        await bot.sendMessage(chatId, "Số lượng không hợp lệ. Vui lòng nhập số nguyên lớn hơn 0.");
        return;
      }

      saveListFlow(chatId, {
        quantity,
        waitingCustomQuantity: false,
      });

      await bot.sendMessage(chatId, `Đã nhận số lượng ${quantity}. Tiếp theo mời bạn chọn topping:`);
      await sendToppingSelection(chatId);
      return;
    }

    const state = sessionService.getSession(chatId).state;
    if (state !== STATES.IDLE) {
      await handleCheckoutStateMessage(chatId, text);
      return;
    }

    if (getChatMode(chatId) !== MODES.AI) {
      await bot.sendMessage(
        chatId,
        "Ban dang o che do LIST. Dung /menu de xem mon, hoac /mode ai neu muon nhap ngon ngu tu nhien.",
        getKeyboardByRole(chatId)
      );
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
