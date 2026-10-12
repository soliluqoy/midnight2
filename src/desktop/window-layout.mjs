// Window sizes and placement in desktop-independent pixels. Keep the visible panel (including its shadow gutter)
// inside the work area; resizing preserves its current centre instead of snapping back to a taskbar corner.
export const GUTTER = 16;
export const MARGIN = 16;
export const SIZES = { idle: [760, 460], chat: [760, 460], mission: [760, 640], settings: [760, 640], stack: [760, 640], search: [760, 460], read: [940, 0] };

export function windowDims(workArea, zoom = 1) {
	const maxW = Math.max(1, Math.floor((workArea.width - MARGIN * 2) / zoom - GUTTER * 2));
	const maxH = Math.max(1, Math.floor((workArea.height - MARGIN * 2) / zoom - GUTTER * 2));
	return Object.fromEntries(Object.entries(SIZES).map(([state, [w, h]]) => [state, [Math.min(w, maxW), Math.min(h || 900, maxH)]]));
}

export function windowBounds(state, workArea, zoom = 1, anchor) {
	const [w, h] = windowDims(workArea, zoom)[state] ?? windowDims(workArea, zoom).mission;
	const width = Math.min(workArea.width, Math.round((w + GUTTER * 2) * zoom));
	const height = Math.min(workArea.height, Math.round((h + GUTTER * 2) * zoom));
	const centre = anchor ?? { x: workArea.x + workArea.width / 2, y: workArea.y + workArea.height / 2 };
	const mx = Math.min(MARGIN, (workArea.width - width) / 2);
	const my = Math.min(MARGIN, (workArea.height - height) / 2);
	return {
		x: Math.round(Math.max(workArea.x + mx, Math.min(centre.x - width / 2, workArea.x + workArea.width - mx - width))),
		y: Math.round(Math.max(workArea.y + my, Math.min(centre.y - height / 2, workArea.y + workArea.height - my - height))),
		width,
		height,
	};
}
