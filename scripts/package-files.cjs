// Each platform needs the shared runtime inclusions as well as its exclusions. In builder 26, an exclusion-only
// platform matcher otherwise gains **/* independently of the normalized shared FileSet and copies the checkout.
// Keep the common runtime list in package.json and inherit complete platform filters from this build-only config.
const { build } = require("../package.json");
module.exports = {
	win: { files: [...build.files, "!node_modules/onnxruntime-node/bin/napi-v6/{darwin,linux}/**", "!node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/**"] },
	mac: { files: [...build.files, "!node_modules/onnxruntime-node/bin/napi-v6/{win32,linux}/**", "!node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/**"] },
	linux: { files: [...build.files, "!node_modules/onnxruntime-node/bin/napi-v6/{win32,darwin}/**", "!node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**"] },
};
