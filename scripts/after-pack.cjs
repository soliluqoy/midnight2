// electron-builder afterPack hook: flips Electron's fuses in the packaged executable before it is signed, with
// @electron/fuses 2.1.3 (pinned in devDependencies; electron-builder's own electronFuses option uses an older copy
// that mistakes any path containing ".app" for a macOS bundle).
//  - RunAsNode, NODE_OPTIONS and --inspect are off: the signed midnight.exe cannot be used as a plain Node.js.
//  - The app only loads from app.asar, and the archive is checked against the hash embedded in the executable,
//    so the installed code cannot be edited in place.
//  - Cookies are encrypted with the OS key store.
//  - GrantFileProtocolExtraPrivileges stays on: midnight's own pages load from file:// inside app.asar, which that
//    fuse is needed for. Turning it off needs the UI served from a custom protocol first.
const path = require("node:path");

exports.default = async function afterPack(context) {
	const fuses = await import("@electron/fuses");
	const { flipFuses, FuseVersion, FuseV1Options } = fuses;
	const platform = context.electronPlatformName;
	const name = platform === "linux" ? context.packager.executableName : context.packager.appInfo.productFilename;
	const executable = path.join(context.appOutDir, `${name}${platform === "darwin" ? ".app" : platform === "win32" ? ".exe" : ""}`);
	await flipFuses(executable, {
		version: FuseVersion.V1,
		resetAdHocDarwinSignature: platform === "darwin",
		[FuseV1Options.RunAsNode]: false,
		[FuseV1Options.EnableCookieEncryption]: true,
		[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
		[FuseV1Options.EnableNodeCliInspectArguments]: false,
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
		[FuseV1Options.OnlyLoadAppFromAsar]: true,
		[FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
	});
	console.log(`  • flipped Electron fuses (@electron/fuses 2.1.3)  executable=${path.relative(process.cwd(), executable)}`);
};
