const fs = require("fs");
const csv = require("csv-parser");

const menuItems = [];

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
};
