const fs = require("fs");
const csv = require("csv-parser");

const menuItems = [];
let menuCsvPath = "";

function normalizeText(value) {
	return String(value || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/đ/g, "d")
		.replace(/Đ/g, "D")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function toBoolean(value) {
	return String(value).toLowerCase() === "true";
}

function toPrice(value) {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function mapRow(row, index) {
	return {
		index: index + 1,
		itemId: row.item_id,
		name: row.name,
		category: row.category,
		description: row.description,
		priceM: toPrice(row.price_m),
		priceL: toPrice(row.price_l),
		available: toBoolean(row.available),
	};
}

function loadMenuFromCsv(csvPath) {
	menuCsvPath = csvPath;
	menuItems.length = 0;

	return new Promise((resolve, reject) => {
		fs.createReadStream(csvPath)
			.pipe(csv())
			.on("data", (row) => {
				menuItems.push(mapRow(row, menuItems.length));
			})
			.on("end", () => resolve(menuItems))
			.on("error", (error) => reject(error));
	});
}

function reindexItems() {
	for (let i = 0; i < menuItems.length; i += 1) {
		menuItems[i].index = i + 1;
	}
}

function toPriceNumber(value) {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeItemCode(itemId) {
	return String(itemId || "").trim().toUpperCase();
}

function isValidCategory(category) {
	return ["Trà Sữa", "Trà Trái Cây", "Cà Phê", "Đá Xay", "Topping"].includes(String(category || "").trim());
}

function addMenuItem(payload) {
	const itemId = normalizeItemCode(payload.itemId);
	if (!itemId) {
		return { ok: false, error: "item_id khong duoc de trong." };
	}

	if (getItemByCode(itemId)) {
		return { ok: false, error: `item_id ${itemId} da ton tai.` };
	}

	const name = String(payload.name || "").trim();
	if (!name) {
		return { ok: false, error: "name khong duoc de trong." };
	}

	const category = String(payload.category || "").trim();
	if (!isValidCategory(category)) {
		return { ok: false, error: "category khong hop le." };
	}

	const priceM = toPriceNumber(payload.priceM);
	const priceLRaw = payload.priceL === undefined || payload.priceL === null || payload.priceL === "" ? payload.priceM : payload.priceL;
	const priceL = toPriceNumber(priceLRaw);
	if (priceM === null || priceL === null) {
		return { ok: false, error: "price_m/price_l phai la so >= 0." };
	}

	const available = typeof payload.available === "boolean" ? payload.available : toBoolean(payload.available);
	const description = String(payload.description || "").trim();

	const nextItem = {
		index: menuItems.length + 1,
		itemId,
		name,
		category,
		description,
		priceM,
		priceL,
		available,
	};

	menuItems.push(nextItem);
	reindexItems();

	return { ok: true, item: nextItem };
}

function updateMenuItem(itemId, updates) {
	const target = getItemByCode(itemId);
	if (!target) {
		return { ok: false, error: `Khong tim thay mon ${itemId}.` };
	}

	if (updates.name !== undefined) {
		const name = String(updates.name || "").trim();
		if (!name) {
			return { ok: false, error: "name khong duoc de trong." };
		}
		target.name = name;
	}

	if (updates.category !== undefined) {
		const category = String(updates.category || "").trim();
		if (!isValidCategory(category)) {
			return { ok: false, error: "category khong hop le." };
		}
		target.category = category;
	}

	if (updates.description !== undefined) {
		target.description = String(updates.description || "").trim();
	}

	if (updates.priceM !== undefined) {
		const priceM = toPriceNumber(updates.priceM);
		if (priceM === null) {
			return { ok: false, error: "price_m phai la so >= 0." };
		}
		target.priceM = priceM;
	}

	if (updates.priceL !== undefined) {
		const priceL = toPriceNumber(updates.priceL);
		if (priceL === null) {
			return { ok: false, error: "price_l phai la so >= 0." };
		}
		target.priceL = priceL;
	}

	if (updates.available !== undefined) {
		target.available = typeof updates.available === "boolean" ? updates.available : toBoolean(updates.available);
	}

	return { ok: true, item: target };
}

function removeMenuItem(itemId) {
	const code = normalizeItemCode(itemId);
	const targetIndex = menuItems.findIndex((item) => String(item.itemId || "").toUpperCase() === code);
	if (targetIndex < 0) {
		return { ok: false, error: `Khong tim thay mon ${code}.` };
	}

	const removed = menuItems.splice(targetIndex, 1)[0];
	reindexItems();
	return { ok: true, item: removed };
}

function escapeCsvCell(value) {
	const text = String(value ?? "");
	if (!/[",\n\r]/.test(text)) {
		return text;
	}

	return `"${text.replace(/"/g, '""')}"`;
}

async function saveMenuToCsv() {
	if (!menuCsvPath) {
		return { ok: false, error: "Chua co duong dan CSV menu." };
	}

	const header = "item_id,name,category,description,price_m,price_l,available";
	const lines = menuItems.map((item) => {
		return [
			escapeCsvCell(item.itemId),
			escapeCsvCell(item.name),
			escapeCsvCell(item.category),
			escapeCsvCell(item.description || ""),
			escapeCsvCell(item.priceM),
			escapeCsvCell(item.priceL),
			escapeCsvCell(Boolean(item.available)),
		].join(",");
	});

	const content = `${[header, ...lines].join("\n")}\n`;
	await fs.promises.writeFile(menuCsvPath, content, "utf8");
	return { ok: true, path: menuCsvPath };
}

function getMenu() {
	return menuItems;
}

function getItemByIndex(itemIndex) {
	if (!Number.isInteger(itemIndex) || itemIndex <= 0) {
		return null;
	}

	return menuItems[itemIndex - 1] || null;
}

function getItemByCode(itemCode) {
	const code = String(itemCode || "").trim().toUpperCase();
	if (!code) {
		return null;
	}

	return menuItems.find((item) => String(item.itemId || "").toUpperCase() === code) || null;
}

function scoreNameMatch(query, itemName) {
	const normalizedQuery = normalizeText(query);
	const normalizedName = normalizeText(itemName);

	if (!normalizedQuery || !normalizedName) {
		return 0;
	}

	if (normalizedQuery === normalizedName) {
		return 1;
	}

	let score = 0;
	if (normalizedName.includes(normalizedQuery)) {
		score += 0.6;
	}

	const queryTokens = normalizedQuery.split(" ").filter(Boolean);
	const nameTokens = normalizedName.split(" ").filter(Boolean);

	if (queryTokens.length > 0) {
		const tokenHits = queryTokens.filter((token) => nameTokens.some((nameToken) => nameToken.includes(token))).length;
		score += (tokenHits / queryTokens.length) * 0.4;
	}

	return Math.min(1, score);
}

function searchItemsByName(query, options = {}) {
	const { limit = 5, minScore = 0.45 } = options;
	const scored = menuItems
		.map((item) => ({
			item,
			score: scoreNameMatch(query, item.name),
		}))
		.filter((result) => result.score >= minScore)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);

	return scored;
}

function getMenuByCategories() {
	const categories = {
		"Trà Sữa": [],
		"Trà Trái Cây": [],
		"Cà Phê": [],
		"Đá Xay": [],
		Topping: [],
	};

	for (const item of menuItems) {
		if (!categories[item.category]) {
			categories[item.category] = [];
		}

		categories[item.category].push(item);
	}

	return categories;
}

module.exports = {
	loadMenuFromCsv,
	getMenu,
	getItemByIndex,
	getItemByCode,
	normalizeText,
	searchItemsByName,
	getMenuByCategories,
	addMenuItem,
	updateMenuItem,
	removeMenuItem,
	saveMenuToCsv,
};
