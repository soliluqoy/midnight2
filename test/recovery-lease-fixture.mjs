import { holdRecoveryProfile } from "../src/recovery/profile.mjs";
const release = holdRecoveryProfile(process.argv[2]);
process.stdin.resume(); process.stdin.once("end", () => { release(); process.exit(0); });
process.stdout.write("READY\n");
