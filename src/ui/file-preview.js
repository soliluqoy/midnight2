(() => {
	const params = new URLSearchParams(location.search);
	const kind = params.get("kind");
	const url = params.get("url") ?? "";
	const name = params.get("name") ?? "File preview";
	document.title = name;
	document.getElementById("name").textContent = name;
	if (!["image", "audio", "video"].includes(kind) || !url.startsWith("file:")) return;
	const media = document.createElement(kind === "image" ? "img" : kind);
	const seconds = Math.max(0, Number(params.get("seconds")) || 0);
	if (kind === "image") media.alt = name;
	else {
		media.controls = true;
		media.preload = "metadata";
		media.addEventListener("loadedmetadata", () => {
			media.currentTime = Math.min(seconds, Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.01) : seconds);
		});
		if (seconds) {
			const mins = Math.floor(seconds / 60);
			const tail = String(Math.floor(seconds % 60)).padStart(2, "0");
			const stamp = seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(mins % 60).padStart(2, "0")}:${tail}` : `${mins}:${tail}`;
			document.getElementById("position").textContent = `Match at ${stamp}`;
		}
	}
	media.addEventListener("error", () => {
		document.getElementById("error").textContent = "This codec cannot play in the preview. Use Show in Explorer to open it in another player.";
	});
	media.src = url;
	document.getElementById("preview").append(media);
})();
