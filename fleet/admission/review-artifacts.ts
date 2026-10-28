/** Fixed protected file boundary shared by admission and its root-only controller. */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ControllerArtifacts } from "./review-controller.ts";

export const ADMISSION_ROOT = "/var/lib/software-factory/review-admission";
export const ADMISSION_CONFIG = "/etc/software-factory/review-admission.json";
const checkDir = (path: string, uid: number) => {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0)
		throw new Error("unprotected directory");
};
export function protectedBytes(path: string, cap = 2_097_152, uid = 0): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.uid !== uid ||
			(stat.mode & 0o022) !== 0 ||
			stat.size > cap ||
			(path === ADMISSION_CONFIG && (stat.mode & 0o007) !== 0)
		)
			throw new Error("unprotected input");
		const bytes = readFileSync(fd);
		if (bytes.length > cap) throw new Error("input bounds");
		return bytes;
	} finally {
		closeSync(fd);
	}
}
export const protectedJSON = (path: string, cap?: number, uid = 0): unknown =>
	JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(protectedBytes(path, cap, uid)));
const safe = (id: string) => {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("artifact id");
	return id;
};
/** Injection is only for deterministic tests; the executable never accepts paths,
 * owner IDs, or roots from argv/environment/repository packets. */
export function controllerArtifacts(
	root = ADMISSION_ROOT,
	captures = "/var/lib/review-jobs/captures",
	issued = "/var/lib/review-issuer/issued",
	uid = 0,
): ControllerArtifacts {
	const artifact = (kind: string, id: string) => {
		checkDir(root, uid);
		checkDir(join(root, safe(kind)), uid);
		return join(root, kind, `${safe(id)}.json`);
	};
	return {
		read: (kind, id) => protectedJSON(artifact(kind, id), undefined, uid),
		readManifest: (id) => protectedBytes(artifact("manifests", id), 16_777_216, uid),
		readIssued: (id) => {
			checkDir(issued, uid);
			return protectedJSON(join(issued, `${safe(id)}.json`), undefined, uid);
		},
		readCapture: (id, lane, file) => {
			for (const path of [captures, join(captures, safe(id)), join(captures, id, lane)])
				checkDir(path, uid);
			return protectedBytes(join(captures, id, lane, file), 8_388_608, uid);
		},
		publish: (kind, id, value) => {
			const dest = artifact(kind, id);
			const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
			if (bytes.length > 2_097_152) throw new Error("artifact bounds");
			const temp = `${dest}.${randomUUID()}.pending`;
			const fd = openSync(
				temp,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o640,
			);
			try {
				fchmodSync(fd, 0o640);
				writeFileSync(fd, bytes);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			let moved = false;
			try {
				try {
					if (kind === "ready") {
						renameSync(temp, dest);
						moved = true;
					} else linkSync(temp, dest);
				} catch (error) {
					if (
						(error as NodeJS.ErrnoException).code !== "EEXIST" ||
						!protectedBytes(dest, 2_097_152, uid).equals(bytes)
					)
						throw error;
				}
				const dir = openSync(join(root, kind), constants.O_RDONLY);
				try {
					fsyncSync(dir);
				} finally {
					closeSync(dir);
				}
			} finally {
				if (!moved) unlinkSync(temp);
			}
		},
	};
}
