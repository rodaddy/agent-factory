import { describe, expect, test } from "bun:test";
import { parseRemoteIdentity } from "../../src/forge/provider";

describe("forge remote identity", () => {
	const accepted = [
		["https://github.com/rodaddy/watcher", "github", "github.com"],
		["git@github.com:rodaddy/watcher.git", "github", "github.com"],
		["https://forge.example.internal/rodaddy/watcher.git", "forgejo", "forge.example.internal"],
		[
			"ssh://git@git-ssh.example.internal:2222/rodaddy/watcher.git",
			"forgejo",
			"forge.example.internal",
		],
	] as const;

	test.each(accepted)("accepts %s", (remote, provider, host) => {
		const identity = parseRemoteIdentity(remote);
		expect(identity?.provider).toBe(provider);
		expect(identity?.host).toBe(host);
		expect(identity?.repository).toBe("rodaddy/watcher");
	});

	test.each([
		"git@git-ssh.example.internal:rodaddy/watcher.git",
		"ssh://git@git-ssh.example.internal:22/rodaddy/watcher.git",
		"ssh://git@github.com/rodaddy/watcher.git",
		"https://git.example.com/rodaddy/watcher.git",
		"https://user@forge.example.internal/rodaddy/watcher.git",
		"https://forge.example.internal/rodaddy/watcher.git?x=1",
		"https://forge.example.internal/rodaddy/watcher.git#x",
		"https://forge.example.internal/extra/rodaddy/watcher.git",
	])("rejects unsupported or ambiguous remote %s", (remote) => {
		expect(parseRemoteIdentity(remote)).toBeNull();
	});
});
