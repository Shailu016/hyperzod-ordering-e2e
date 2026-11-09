const EMPTY_ORDER_LINES = [
	/^no orders?(?: yet)?$/i,
	/^you don['’]t have any past orders?$/i,
];

function hasEmptyOrdersState(text) {
	const lines = String(text ?? "")
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, ""));
	return lines.some((line) => EMPTY_ORDER_LINES.some((pattern) => pattern.test(line)));
}

module.exports = { hasEmptyOrdersState };
