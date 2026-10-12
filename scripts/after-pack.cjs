// electron-builder afterPack hook: flips Electron's fuses in the packaged executable before it is signed.
// (electron-builder's own electronFuses option looks for the macOS framework on Windows builds.)
//  - RunAsNode, NODE_OPTIONS and --inspect are off: the signed midnight.exe cannot be used as a plain Node.js.
//  - The app only loads from app.asar, and the archive is checked against the hash embedded in the executable,
//    so the installed code cannot be edited in place.
//  - Cookies are encrypted with the OS key store.
//  - GrantFileProtocolExtraPrivileges stays on: midnight's own pages load from file:// inside app.asar, which that
//    fuse is needed for. Turning it off needs the UI served from a custom protocol first.
const path = require("node:path");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

exports.default = async function afterPack(context) {
	const platform = context.electronPlatformName;
	const name = platform === "linux" ? context.packager.executableName : context.packager.appInfo.productFilename;
	const executable = path.join(context.appOutDir, `${name}${platform === "darwin" ? ".app" : platform === "win32" ? ".exe" : ""}`);
	// @electron/fuses treats any path containing ".app" as a macOS bundle (a checkout folder named "midnight.app"
	// would match), so Windows and Linux pass the executable's name relative to its folder.
	const cwd = process.cwd();
	if (platform !== "darwin") process.chdir(context.appOutDir);
	try {
		await flip(platform === "darwin" ? executable : path.basename(executable), platform);
	} finally {
		process.chdir(cwd);
	}
	console.log(`  • flipped Electron fuses  executable=${path.relative(cwd, executable)}`);
};

function flip(executable, platform) {
	return flipFuses(executable, {
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
}
