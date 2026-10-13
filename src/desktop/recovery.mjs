// The standalone recovery helper uses this small profile marker/owner record, independent of the mission schema.
import { fileURLToPath } from "node:url";
export { registerRecoveryProfile } from "../recovery/profile.mjs";

export const RECOVERY_HELPER = fileURLToPath(new URL("./native/midnight-recovery.exe", import.meta.url)).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
