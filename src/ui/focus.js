// Keyboard focus containment for decision cards and dialogs. While a container is active, Tab and Shift+Tab cycle
// through its controls instead of leaving it; focus starts on the container itself (never on a button, so a
// stray Enter cannot approve anything) and returns where it was when the container is released.
window.focusTrap = (() => {
	const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
	let active; // { container, previous }
	const visible = (el) => !el.closest("[hidden],[inert]") && el.getClientRects().length > 0;
	function onKey(e) {
		if (e.key !== "Tab" || !active || !active.container.isConnected || !visible(active.container)) return;
		const items = [...active.container.querySelectorAll(FOCUSABLE)].filter(visible);
		if (!items.length) {
			e.preventDefault();
			active.container.focus();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const inside = active.container.contains(document.activeElement);
		if (!inside) {
			e.preventDefault();
			(e.shiftKey ? last : first).focus();
		} else if (e.shiftKey && (document.activeElement === first || document.activeElement === active.container)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}
	document.addEventListener("keydown", onKey, true);
	return {
		/** Contain focus in `container` until release() or another contain(). */
		contain(container, { focus = true } = {}) {
			if (active?.container === container) return;
			const previous = active?.previous ?? document.activeElement;
			active = { container, previous };
			if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
			if (focus) container.focus({ preventScroll: true });
		},
		release(container) {
			if (!active || (container && active.container !== container)) return;
			const { previous } = active;
			const hadFocus = active.container.contains(document.activeElement);
			active = undefined;
			if (hadFocus && previous?.isConnected && visible(previous)) previous.focus({ preventScroll: true });
		},
		get active() {
			return active?.container;
		},
	};
})();
