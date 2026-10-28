/** Compile/install as /usr/local/bin/factory-review-admission. No host apply here. */
import { createPublicKey } from "node:crypto";
import { SQL } from "bun";
import { z } from "zod";
import {
	type AdmissionCASRecord,
	type AdmissionRow,
	createAdmissionStore,
} from "./operation-admission-store.js";
import {
	admitForgeReview,
	createReviewReceiptAuthority,
	finishForgeReview,
	type ReviewAdmissionHost,
	registerReviewWork,
} from "./review-admission.ts";
import type { ReviewRoundRecord } from "./review-rounds.js";

import { ADMISSION_CONFIG, controllerArtifacts, protectedJSON } from "./review-artifacts.ts";
import { collectReview, completeProtectedReview } from "./review-controller.ts";
const artifacts = controllerArtifacts();
const artifact = artifacts.read;
const configSchema = z.strictObject({
	companyId: z.string().min(1),
	databaseUrl: z.string().min(1),
	publicKeys: z.record(z.string(), z.string()),
	attestationPublicKeys: z.record(z.string(), z.string()).default({}),
});
let sql: SQL | undefined;
try {
	const verb = process.argv[2];
	const controller = verb === "collect" || verb === "complete-record";
	if (
		!["admit", "register", "complete", "collect", "complete-record"].includes(verb ?? "") ||
		process.argv.length !== (controller ? 4 : 3)
	)
		throw new Error("verb");
	if (verb !== "admit" && process.getuid?.() !== 0) throw new Error("operator required");
	const id = process.argv[3] ?? "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (!controller)
		for await (const chunk of Bun.stdin.stream()) {
			size += chunk.length;
			if (size > 1_048_576) throw new Error("request bounds");
			chunks.push(chunk);
		}
	const input = controller
		? (artifact(verb === "collect" ? "prepared" : "terminals", id) as {
				target: { companyId: string };
			})
		: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	const config = configSchema.parse(protectedJSON(ADMISSION_CONFIG, 65_536));
	const targetCompany =
		controller || verb === "register" ? input.target?.companyId : input.companyId;
	if (targetCompany !== config.companyId) throw new Error("company mismatch");
	sql = new SQL(config.databaseUrl, { max: 1, connectionTimeout: 5 });
	const database = sql;
	const query = async <T extends AdmissionCASRecord>(text: string, values: unknown[]) =>
		(await database.unsafe(text, values)) as AdmissionRow<T>[];
	const host: ReviewAdmissionHost = {
		aliases: createAdmissionStore({ companyId: config.companyId, query }),
		rounds: createAdmissionStore<ReviewRoundRecord>({ companyId: config.companyId, query }),
		authority: createReviewReceiptAuthority(
			{
				publicKeys: new Map(
					Object.entries(config.publicKeys).map(([id, pem]) => [id, createPublicKey(pem)]),
				),
				attestationPublicKeys: new Map(
					Object.entries(config.attestationPublicKeys).map(([id, pem]) => [
						id,
						createPublicKey(pem),
					]),
				),
			},
			artifact,
		),
		readReady: async (target, workItemId) => {
			const value = artifact(
				"ready",
				`${target.repositoryId}-${target.pr}-${target.headSha}`,
			) as Awaited<ReturnType<ReviewAdmissionHost["readReady"]>>;
			return value?.expected.workItemId === workItemId ? value : null;
		},
		now: Date.now,
	};
	const result =
		verb === "collect"
			? await collectReview(host, artifacts, id)
			: verb === "complete-record"
				? await completeProtectedReview(host, artifacts, id)
				: verb === "admit"
					? await admitForgeReview(host, input)
					: verb === "register"
						? await registerReviewWork(host, input)
						: await finishForgeReview(host, input.reservation, input.completion);
	process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
	process.stdout.write('{"action":"hold","cause":"trusted_admission_unavailable"}\n');
	process.exitCode = 1;
} finally {
	await sql?.close();
}
