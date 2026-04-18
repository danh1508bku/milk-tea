const carts = new Map();

function createEmptyCart(chatId) {
	return {
		chatId,
		items: [],
		updatedAt: new Date().toISOString(),
	};
}

function touchCart(cart) {
	cart.updatedAt = new Date().toISOString();
}

function getOrCreateCart(chatId) {
	if (!carts.has(chatId)) {
		carts.set(chatId, createEmptyCart(chatId));
	}

	return carts.get(chatId);
}

function getCart(chatId) {
	return carts.get(chatId) || createEmptyCart(chatId);
}

function addItem(chatId, item) {
	const cart = getOrCreateCart(chatId);
	cart.items.push(item);
	touchCart(cart);
	return cart;
}

function removeItemByLine(chatId, lineNumber) {
	const cart = carts.get(chatId);
	if (!cart || cart.items.length === 0) {
		return { ok: false, error: "Giỏ hàng đang trống." };
	}

	if (!Number.isInteger(lineNumber) || lineNumber <= 0 || lineNumber > cart.items.length) {
		return { ok: false, error: "Số dòng không hợp lệ. Dùng /cart để xem lại số thứ tự." };
	}

	const [removed] = cart.items.splice(lineNumber - 1, 1);
	touchCart(cart);
	return { ok: true, removed, cart };
}

function updateItemQuantityByLine(chatId, lineNumber, quantity) {
	const cart = carts.get(chatId);
	if (!cart || cart.items.length === 0) {
		return { ok: false, error: "Giỏ hàng đang trống." };
	}

	if (!Number.isInteger(lineNumber) || lineNumber <= 0 || lineNumber > cart.items.length) {
		return { ok: false, error: "Số dòng không hợp lệ. Dùng /cart để xem lại số thứ tự." };
	}

	if (!Number.isInteger(quantity) || quantity < 0) {
		return { ok: false, error: "Số lượng phải là số nguyên >= 0." };
	}

	if (quantity === 0) {
		const [removed] = cart.items.splice(lineNumber - 1, 1);
		touchCart(cart);
		return { ok: true, removed, cart, deleted: true };
	}

	const target = cart.items[lineNumber - 1];
	target.quantity = quantity;
	touchCart(cart);
	return { ok: true, item: target, cart };
}

function adjustItemQuantityByLine(chatId, lineNumber, delta) {
	const cart = carts.get(chatId);
	if (!cart || cart.items.length === 0) {
		return { ok: false, error: "Giỏ hàng đang trống." };
	}

	if (!Number.isInteger(lineNumber) || lineNumber <= 0 || lineNumber > cart.items.length) {
		return { ok: false, error: "Số dòng không hợp lệ. Dùng /cart để xem lại số thứ tự." };
	}

	if (!Number.isInteger(delta) || delta === 0) {
		return { ok: false, error: "Mức thay đổi số lượng không hợp lệ." };
	}

	const target = cart.items[lineNumber - 1];
	const nextQuantity = Number(target.quantity || 0) + delta;
	if (nextQuantity <= 0) {
		const [removed] = cart.items.splice(lineNumber - 1, 1);
		touchCart(cart);
		return { ok: true, removed, cart, deleted: true };
	}

	target.quantity = nextQuantity;
	touchCart(cart);
	return { ok: true, item: target, cart };
}

function clearCart(chatId) {
	carts.delete(chatId);
}

function isCartEmpty(chatId) {
	const cart = carts.get(chatId);
	return !cart || cart.items.length === 0;
}

function getCartTotal(chatId) {
	const cart = carts.get(chatId);
	if (!cart) {
		return 0;
	}

	return cart.items.reduce((total, item) => {
		const quantity = Number(item.quantity || 0);
		const hasSeparatedPricing = item.baseUnitPrice !== undefined && item.baseUnitPrice !== null;
		if (hasSeparatedPricing) {
			const base = Number(item.baseUnitPrice || 0);
			const toppingDetails = Array.isArray(item.toppingDetails) ? item.toppingDetails : [];
			const toppingUnit = toppingDetails.reduce((sum, top) => sum + Number(top.unitPrice || 0), 0);
			return total + (base + toppingUnit) * quantity;
		}

		return total + Number(item.unitPrice || 0) * quantity;
	}, 0);
}

module.exports = {
	getCart,
	getOrCreateCart,
	addItem,
	removeItemByLine,
	updateItemQuantityByLine,
	adjustItemQuantityByLine,
	clearCart,
	isCartEmpty,
	getCartTotal,
};
