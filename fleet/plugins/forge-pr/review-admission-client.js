// Fixed protected executable, never a command/path selected by a PR or plugin config.
import { spawn } from "node:child_process";

const COMMAND = "/usr/local/bin/factory-review-admission";
export function invokeReviewAdmission(input) {
	return new Promise((resolve) => {
		const hold = () => resolve({ action: "hold", cause: "trusted_admission_unavailable" });
		const child = spawn(COMMAND, ["admit"], { stdio: ["pipe", "pipe", "ignore"], env: {} });
		let output = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			hold();
		}, 10_000);
		child.on("error", () => {
			clearTimeout(timer);
			hold();
		});
		child.stdin.on("error", hold);
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (Buffer.byteLength(output) > 16_384) {
				child.kill("SIGKILL");
				hold();
			}
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return hold();
			try {
				resolve(JSON.parse(output));
			} catch {
				hold();
			}
		});
		child.stdin.end(JSON.stringify(input));
	});
}

import { reviewAdmissionFor as buildAdmission } from "./review-admission.js";
export const reviewAdmissionFor = (companyId, forgeGet) =>
	buildAdmission(companyId, forgeGet, invokeReviewAdmission);
